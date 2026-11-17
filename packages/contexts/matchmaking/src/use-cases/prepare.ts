import type { MatchmakingRuntime, MatchmakingWrite } from "./ports";
import { cpuRetryDelayMs, type State, type Group } from "../domain/state";

import { rollback } from "./rollback";
export async function prepare(r: MatchmakingRuntime, state: State, group: Group) {
  const statements: MatchmakingWrite[] = [];
  for (const player of group.players) {
    const profile = await r.store.profile(player.accountId, Boolean(r.ratingPolicy));
    if (!profile || player.expiresAtMs <= r.now()) {
      await rollback(r, state, group, [player.accountId]);
      return;
    }
    player.admission = {
      accountId: player.accountId,
      operationId: `${group.id}:${player.accountId}`,
      roomId: group.roomId,
      instanceId: group.instanceId,
      playerId: player.admission.playerId,
      name: profile.name,
      avatarKey: profile.avatarKey,
      avatarPresetId: profile.avatarPresetId,
      ...(profile.isAnonymous ? { isGuest: true } : {}),
    };
    player.tokenHash = (await r.credential(player, state.key)).tokenHash;
    statements.push(...r.store.preparePlayer(player, group, r.now()));
  }
  r.storage.save(state);
  try {
    await r.store.commit(statements);
  } catch {
    await rollback(r, state, group, [], 5000);
    return;
  }
  const created = await prepareRoom(r, group);
  if (created.status === "cpu_capacity_full") {
    state.cpuRetryAtMs = r.now() + cpuRetryDelayMs;
    group.capacityBlocked = true;
    await rollback(r, state, group, [], 0, "cpu_capacity");
    for (const { diagnosticId } of group.players)
      if (diagnosticId)
        r.diagnostic("four_shogi_cpu_capacity_wait", {
          diagnosticId,
          atMs: r.now(),
        });
    return;
  }
  if (created.status !== "prepared") {
    await rollback(r, state, group, [], 5000);
    return;
  }
  group.phase = "matched";
  for (const p of group.players) r.event(p, "matched", null, group);
  if (group.players.length < r.queueRules.seats) delete state.cpuRetryAtMs;
  r.storage.save(state);
  const atMs = r.now();
  for (const { diagnosticId } of group.players)
    if (diagnosticId)
      r.diagnostic("four_shogi_assigned", {
        diagnosticId,
        matchId: group.id,
        atMs,
      });
}

async function prepareRoom(r: MatchmakingRuntime, group: Group) {
  const matchSequence =
    group.assignSequence && group.rating
      ? await r.reserveMatchSequence(group.id, `rated:${r.game}`)
      : undefined;
  return r.room(group.roomId).prepareMatchmakingRoom({
    ...(matchSequence === undefined ? {} : { matchSequence }),
    game: r.game,
    matchId: group.id,
    roomId: group.roomId,
    instanceId: group.instanceId,
    preparedAtMs: group.preparedAtMs,
    expiresAtMs: group.expiresAtMs,
    ...(group.rating ? { rating: group.rating } : {}),
    players: group.players.map((p) => ({
      admission: p.admission,
      tokenHash: p.tokenHash,
      version: p.version,
      search: { operationId: p.operationId, joinedAtMs: p.joinedAtMs, isTest: p.isTest ?? false },
    })),
  });
}
