import type { MatchmakingRuntime } from "./ports";
import { type State, type Wait, type Group } from "../domain/state";
import type { QueueRatingSource } from "../domain/ratedMatchmaking";

import { orderWaits } from "../domain/waits";
import { forget, rollback, recoverCredentials, releaseWaitingReservations } from "./rollback";
import { prepare } from "./prepare";
export async function tick(r: MatchmakingRuntime, state: State) {
  if (r.ratingPolicy && state.waiting.length) {
    const blocked = await r.store.pendingAccounts(state.waiting.map((wait) => wait.accountId));
    for (const wait of state.waiting)
      if (blocked.has(wait.accountId)) await forget(r, wait, state, "invalidated");
    state.waiting = state.waiting.filter((wait) => !blocked.has(wait.accountId));
  }
  await reconcileGroups(r, state);
  if (r.retired) {
    for (const wait of state.waiting) await forget(r, wait, state);
    state.waiting = [];
    return;
  }
  const validRows = state.waiting.length ? await r.store.validWaits(state.key, r.now()) : [];
  const valid = new Set(validRows.map((row) => row.operationId));
  for (const wait of [...state.waiting]) {
    if (
      wait.expiresAtMs <= r.now() ||
      !valid.has(wait.operationId) ||
      r.storage.ended(wait.operationId)
    ) {
      await forget(r, wait, state, wait.expiresAtMs <= r.now() ? "lease_expired" : "invalidated");
      state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
    }
  }
  orderWaits(r, state);
  await formGroups(r, state);
}

async function reconcileGroups(r: MatchmakingRuntime, state: State) {
  for (const group of [...state.groups]) {
    if (group.phase === "playing") {
      if (group.players.some((p) => p.credentialPending)) await recoverCredentials(r, state, group);
      continue;
    }
    if (group.phase === "cancelling") {
      await rollback(r, state, group, group.remove ?? []);
      continue;
    }
    if (group.phase === "preparing") {
      await prepare(r, state, group);
      continue;
    }
    await recoverCredentials(r, state, group);
    const room = await r.room(group.roomId).getMatchmakingState(group.id, group.instanceId);
    if (room.phase === "playing" || room.started) {
      await releaseWaitingReservations(r, group);
      group.phase = "playing";
      if (!room.occupiedPlayerIds.length) {
        for (const p of group.players) r.storage.end(p.operationId);
        state.groups = state.groups.filter((g) => g.id !== group.id);
      }
      for (const p of group.players)
        p.released = !room.occupiedPlayerIds.includes(p.admission.playerId);
      continue;
    }
    if (room.phase === "closed" && room.aiUnavailable) {
      // AIの準備失敗では入室状況にかかわらず、参加資格が残る人を待機列へ戻します。
      await rollback(r, state, group, [], 5000, "ai_unavailable");
      continue;
    }
    if (room.phase === "closed" || r.now() >= group.expiresAtMs) {
      const connected = room.connectedPlayerIds;
      await rollback(
        r,
        state,
        group,
        group.players
          .filter((p) => !connected.includes(p.admission.playerId))
          .map((p) => p.accountId),
        0,
        "connection_timeout",
      );
    }
  }
}

async function formGroups(r: MatchmakingRuntime, state: State) {
  let remaining = 4;
  while (remaining-- > 0) {
    const eligible = state.waiting.filter((w) => (w.retryAtMs ?? 0) <= r.now());
    const oldest = eligible[0];
    if (!oldest) break;
    const now = r.now();
    const elapsed = now - oldest.joinedAtMs;
    let selected: Wait[];
    let rating: QueueRatingSource | undefined;
    const policy = r.ratingPolicy;
    if (policy) {
      let match = policy.select(eligible, elapsed);
      if ((state.cpuRetryAtMs ?? 0) > now && match?.selected.length !== r.queueRules.seats) {
        // CPU枠待ちの先頭を残し、後続の人間同士で成立できる組合せを探します。
        match = undefined;
        for (let i = 1; i <= eligible.length - r.queueRules.seats; i++) {
          const candidate = policy.select(eligible.slice(i), now - eligible[i]!.joinedAtMs);
          if (candidate?.selected.length === r.queueRules.seats) {
            match = candidate;
            break;
          }
        }
      }
      if (!match) break;
      ({ selected, rating } = match);
    } else {
      const { seats, fillAfterMs } = r.queueRules;
      if (eligible.length < seats && elapsed < fillAfterMs) break;
      selected = eligible.slice(0, seats);
    }
    const ids = new Set(selected.map((w) => w.operationId));
    state.waiting = state.waiting.filter((w) => !ids.has(w.operationId));
    const group = createGroup(r, selected, rating, now);
    state.groups.push(group);
    r.storage.save(state);
    await prepare(r, state, group);
  }
}

function createGroup(
  r: MatchmakingRuntime,
  selected: Wait[],
  rating: QueueRatingSource | undefined,
  now: number,
): Group {
  const id = r.randomId(),
    roomId = r.randomRoomId(),
    instanceId = r.randomId();
  const group: Group = {
    ...(rating ? { assignSequence: true as const } : {}),
    id,
    roomId,
    instanceId,
    preparedAtMs: now,
    expiresAtMs: now + r.queueRules.connectionGraceMs,
    phase: "preparing",
    ...(rating ? { rating } : {}),
    players: selected.map((w) => ({
      ...w,
      released: false,
      credentialPending: false,
      tokenHash: "",
      admission: {
        accountId: w.accountId,
        operationId: `${id}:${w.accountId}`,
        roomId,
        instanceId,
        playerId: r.randomId(),
        name: "",
        avatarKey: null,
      },
    })),
  };
  return group;
}
