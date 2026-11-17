import type { MatchmakingRuntime } from "./ports";
import {
  type State,
  type Wait,
  type Group,
  type Player,
  type MatchmakingReason,
} from "../domain/state";

export async function forget(
  r: MatchmakingRuntime,
  wait: Wait,
  state: State,
  reason: MatchmakingReason = "invalidated",
  group?: Group,
) {
  r.event(wait, reason === "cancelled" ? "cancelled" : "failed", reason, group);
  r.storage.endAndSave(wait.operationId, state);
  await r.store.forget(wait);
}

export async function rollback(
  r: MatchmakingRuntime,
  state: State,
  group: Group,
  remove: string[],
  retryDelayMs = group.retryDelayMs ?? 0,
  reason: MatchmakingReason = group.rollbackReason ?? "unavailable",
) {
  group.rollbackReason = reason;
  group.phase = "cancelling";
  group.remove = remove;
  group.retryDelayMs = retryDelayMs;
  r.storage.save(state);
  const result = await r.room(group.roomId).abortMatchmakingRoom(group.id, group.instanceId);
  if (result.status === "already_started") {
    await releaseWaitingReservations(r, group);
    group.phase = "playing";
    delete group.remove;
    r.storage.save(state);
    return;
  }
  for (const player of group.players) await r.releaseReservation(player.admission);
  const policy = r.ratingPolicy;
  if (group.rating && policy) await r.store.clearPending(group.id);
  for (const player of group.players) {
    if (
      remove.includes(player.accountId) ||
      !(await r.store.profile(player.accountId, Boolean(r.ratingPolicy))) ||
      r.storage.ended(player.operationId)
    )
      await forget(
        r,
        player,
        state,
        remove.includes(player.accountId) ? reason : "invalidated",
        group,
      );
    else await restorePlayer(r, state, group, player, retryDelayMs, reason);
  }
  state.groups = state.groups.filter((g) => g.id !== group.id);
  r.storage.save(state);
}

export async function releaseWaitingReservations(r: MatchmakingRuntime, group: Group) {
  await r.store.releaseWaiting(group);
}

export async function recoverCredentials(r: MatchmakingRuntime, state: State, group: Group) {
  for (const player of group.players) {
    if (!player.credentialPending || player.released) continue;
    player.tokenHash = (await r.credential(player, state.key)).tokenHash;
    r.storage.save(state);
    const updated = await r
      .room(group.roomId)
      .rekeyMatchmakingPlayer(
        group.id,
        group.instanceId,
        player.admission.playerId,
        player.version,
        player.tokenHash,
      );
    if (updated) {
      player.credentialPending = false;
      r.storage.save(state);
    } else {
      const seat = await r.store.hasSeat(player.accountId, player.admission.operationId);
      if (!seat) {
        player.released = true;
        player.credentialPending = false;
        r.storage.save(state);
      }
    }
  }
}

async function restorePlayer(
  r: MatchmakingRuntime,
  state: State,
  group: Group,
  player: Player,
  retryDelayMs: number,
  reason: MatchmakingReason,
) {
  if (!group.capacityBlocked) {
    player.expiresAtMs = r.now() + r.queueRules.leaseMs;
    player.retryAtMs = r.now() + retryDelayMs;
  }
  const updated = await r.store.restore(player);
  if (updated && !state.waiting.some((w) => w.accountId === player.accountId)) {
    r.event(player, "retry", reason, group);
    state.waiting.push({
      accountId: player.accountId,
      operationId: player.operationId,
      controllerId: player.controllerId,
      version: player.version,
      joinedAtMs: player.joinedAtMs,
      sequence: player.sequence,
      isTest: player.isTest,
      ...(player.diagnosticId ? { diagnosticId: player.diagnosticId } : {}),
      ...(player.rating === undefined ? {} : { rating: player.rating }),
      ...(player.sigma === undefined ? {} : { sigma: player.sigma, ratedGames: player.ratedGames }),
      expiresAtMs: player.expiresAtMs,
      retryAtMs: player.retryAtMs,
    });
  } else if (!updated) await forget(r, player, state, "invalidated", group);
}
