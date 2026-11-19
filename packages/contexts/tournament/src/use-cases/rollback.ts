import type { TournamentQueueRuntime } from "./ports";
import type { State, Group } from "../domain/queue";
import { tokenKey } from "../domain/queue";
import { stage } from "../domain/stage";
import { forget } from "./waiting";
export async function rollback(
  r: TournamentQueueRuntime,
  state: State,
  group: Group,
  remove: string[],
) {
  // 旧版が取消途中で保存した組は、旧版と同じく復帰時に待機期限を付け直します。
  group.rollbackAfterPublication ??=
    group.phase === "matched" ||
    (group.phase === "cancelling" &&
      group.players.every((player) => player.waitingExpiresAtMs === undefined));
  group.phase = "cancelling";
  const removedAccounts = new Set([...(group.remove ?? []), ...remove]);
  group.remove = [...removedAccounts];
  r.storage.save(state);
  const result = await r.room(group.roomId).abortTournamentRoom(
    group.id,
    group.players
      .filter((player) => removedAccounts.has(player.accountId))
      .map((player) => player.admission.playerId),
  );
  if (result.status === "already_started") {
    group.phase = "playing";
    delete group.remove;
    delete group.rollbackAfterPublication;
    r.storage.save(state);
    return;
  }
  for (const player of group.players) await r.releaseReservation(player.admission);
  await r.store.markAborted(group);
  const row = await r.read(state.key);
  for (const { waitingExpiresAtMs, ...player } of group.players) {
    const canRestore =
      !removedAccounts.has(player.accountId) &&
      row &&
      !r.storage.cancelled(tokenKey(player.accountId, player.operationId)) &&
      (await r.eligible(player.accountId, state.key));
    const now = r.now();
    const expiresAtMs = group.rollbackAfterPublication
      ? now + r.rules.leaseMs
      : (waitingExpiresAtMs ?? group.expiresAtMs);
    if (!canRestore || !row || stage(row, now) !== "active" || expiresAtMs <= now) {
      await forget(r, player);
      continue;
    }
    const wait = { ...player, expiresAtMs, credentialPending: false };
    if (!(await r.store.restore(wait, state.key))) {
      await forget(r, player);
      continue;
    }
    if (!state.waiting.some((w) => w.accountId === player.accountId)) state.waiting.push(wait);
  }
  state.groups = state.groups.filter((g) => g.id !== group.id);
  r.storage.save(state);
}
