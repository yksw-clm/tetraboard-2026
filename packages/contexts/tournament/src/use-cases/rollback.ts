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
  group.phase = "cancelling";
  group.remove = remove;
  r.storage.save(state);
  const result = await r.room(group.roomId).abortTournamentRoom(
    group.id,
    group.players
      .filter((player) => remove.includes(player.accountId))
      .map((player) => player.admission.playerId),
  );
  if (result.status === "already_started") {
    group.phase = "playing";
    delete group.remove;
    r.storage.save(state);
    return;
  }
  for (const player of group.players) await r.releaseReservation(player.admission);
  await r.store.markAborted(group);
  const row = await r.read(state.key);
  for (const player of group.players) {
    if (
      remove.includes(player.accountId) ||
      !row ||
      stage(row, r.now()) !== "active" ||
      r.storage.cancelled(tokenKey(player.accountId, player.operationId)) ||
      !(await r.eligible(player.accountId, state.key))
    ) {
      await forget(r, player);
      continue;
    }
    player.expiresAtMs = r.now() + r.rules.leaseMs;
    await r.store.restore(player, state.key);
    if (!state.waiting.some((w) => w.accountId === player.accountId))
      state.waiting.push({ ...player, credentialPending: false });
  }
  state.groups = state.groups.filter((g) => g.id !== group.id);
  r.storage.save(state);
}
