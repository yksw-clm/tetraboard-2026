import type { TournamentQueueRuntime } from "./ports";
import type { State, Group } from "../domain/queue";
import type { TournamentRow } from "../domain/types";
import { stage } from "../domain/stage";
import { forget, validWait, leaseValid } from "./waiting";
import { rollback } from "./rollback";
import { transfer } from "./transfer";
import { formGroup } from "./groups";
import { syncCredential } from "./control";
export async function tick(r: TournamentQueueRuntime, state: State) {
  const row = await r.read(state.key);
  if (!row || !row.published) {
    await r.storage.deleteAlarm();
    return;
  }
  const active = stage(row, r.now()) === "active";
  const profiles = state.waiting.length ? await r.store.waitingProfiles(state.key) : new Map();
  for (const wait of [...state.waiting])
    if (!active || !validWait(r, wait) || !profiles.has(wait.operationId)) {
      await forget(r, wait);
      state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
      r.storage.save(state);
    }
  for (const group of [...state.groups]) {
    await advanceGroup(r, state, group, row, active);
  }
  if (active)
    while (state.waiting.length >= 4) {
      const before = state.waiting.length;
      await formGroup(r, state, row);
      if (before === state.waiting.length) break;
    }
  await r.finalize(state.key);
  await schedule(r, state, row);
}
export async function advanceGroup(
  r: TournamentQueueRuntime,
  state: State,
  group: Group,
  row: TournamentRow,
  active: boolean,
) {
  if (group.phase === "cancelling") {
    await rollback(r, state, group, group.remove ?? []);
    return;
  }
  // 旧版で保存された参加確認待ちも、確認操作なしでルーム準備へ移します。
  if (group.phase === "confirming" || group.phase === "preparing") {
    await r.store.ensureGroup(state, group);
    if (!active || group.expiresAtMs <= r.now()) {
      await rollback(
        r,
        state,
        group,
        group.players.map((p) => p.accountId),
      );
      return;
    }
    const invalid: string[] = [];
    for (const p of group.players)
      if (!(await leaseValid(r, p, state.key))) invalid.push(p.accountId);
    if (invalid.length) {
      await rollback(r, state, group, invalid);
      return;
    }
    await transfer(r, state, group, row);
  } else {
    await inspectRoom(r, state, group, active);
  }
}
export async function inspectRoom(
  r: TournamentQueueRuntime,
  state: State,
  group: Group,
  active: boolean,
) {
  for (const player of group.players)
    if (player.credentialPending) await syncCredential(r, state, group, player);
  const room =
    group.phase === "playing"
      ? null
      : await r.room(group.roomId).getTournamentReservationState(group.id);
  if (room?.startedAtMs !== undefined) {
    group.phase = "playing";
    r.storage.save(state);
    await r.store.markPlaying(group, room.startedAtMs);
  } else if (room && (room.status === "closed" || !active || group.expiresAtMs <= r.now())) {
    const connected = room.connectedPlayerIds;
    // Recreate a lease only for clients that actually reached the room.
    for (const p of group.players)
      if (connected.includes(p.admission.playerId) && (await r.eligible(p.accountId, state.key))) {
        p.expiresAtMs = r.now() + r.rules.leaseMs;
      }
    await rollback(
      r,
      state,
      group,
      group.players
        .filter((p) => !connected.includes(p.admission.playerId))
        .map((p) => p.accountId),
    );
    return;
  }
  if (group.phase === "playing") {
    const ledger = await r.store.ledgerPhase(group);
    const occupied = await r.store.occupied(group);
    if (!occupied && (ledger?.phase === "saved" || ledger?.phase === "aborted")) {
      for (const player of group.players) await forget(r, player);
      state.groups = state.groups.filter((g) => g.id !== group.id);
      r.storage.save(state);
    }
  }
}
export async function schedule(r: TournamentQueueRuntime, state: State, row: TournamentRow) {
  const now = r.now();
  const next = [
    ...state.waiting.map((w) => w.expiresAtMs),
    ...state.groups.map((g) =>
      g.phase === "playing" || g.phase === "cancelling"
        ? now + 5000
        : Math.min(g.expiresAtMs, now + 5000),
    ),
    ...(row.finalized_at_ms === null ? [row.ends_at_ms!] : []),
  ].filter((n) => n > now);
  if (row.ends_at_ms! <= now && row.finalized_at_ms === null) {
    const fresh = await r.read(row.key);
    if (fresh?.finalized_at_ms === null) next.push(now + 5000);
  }
  if (next.length) await r.storage.setAlarm(Math.min(...next));
  else await r.storage.deleteAlarm();
}
