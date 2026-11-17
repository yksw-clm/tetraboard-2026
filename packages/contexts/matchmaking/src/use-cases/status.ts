import type { MatchmakingRuntime } from "./ports";
import { type State, type Wait, type Group } from "../domain/state";

import type { MatchmakingState } from "@tetraboard/protocol";
import { estimatedMatchAt } from "../domain/estimatedMatchAt";
import { ratingOpponentKind } from "../domain/ratedMatchmaking";
import { locate } from "../domain/waits";
export async function availableCpuSeats(r: MatchmakingRuntime): Promise<number | undefined> {
  if (!r.ratingPolicy) return;
  try {
    return await r.availableCpuSeats();
  } catch {
    return;
  }
}

export async function snapshot(
  r: MatchmakingRuntime,
  state: State,
  accountId: string | null,
  controllerId?: string,
  readonly = false,
  includeWaitingInfo = true,
): Promise<MatchmakingState> {
  const cpuSeats = includeWaitingInfo ? await availableCpuSeats(r) : undefined;
  const now = r.now();
  const waitingCount =
    cpuSeats === undefined
      ? undefined
      : state.waiting.filter((wait) => wait.expiresAtMs > now).length + cpuSeats;
  const summary = { serverNowMs: now, ...(waitingCount === undefined ? {} : { waitingCount }) };
  if (accountId === null) return { status: "idle", ...summary };
  const { wait, group } = locate(state, accountId);
  if (!wait) return { status: "idle", ...summary };
  if (group && group.phase !== "playing" && r.now() >= group.expiresAtMs)
    return { status: "idle", ...summary };
  if (!group) {
    const lease = await r.store.hasLease(accountId, wait.operationId, r.now());
    if (wait.expiresAtMs <= r.now() || !lease) return { status: "idle", ...summary };
  }
  if (group && (group.phase === "playing" || group.phase === "matched")) {
    const seat = await r.store.hasSeat(
      accountId,
      group.players.find((p) => p.accountId === accountId)!.admission.operationId,
    );
    if (!seat) {
      if (readonly || group.phase !== "playing") return { status: "idle", ...summary };
      group.players.find((p) => p.accountId === accountId)!.released = true;
      r.storage.end(wait.operationId);
      if (group.players.every((p) => p.released))
        state.groups = state.groups.filter((g) => g.id !== group.id);
      return { status: "idle", ...summary };
    }
  }
  const result: MatchmakingState = {
    status: group ? (group.phase === "playing" ? "playing" : "matched") : "waiting",
    ...summary,
    operationId: wait.operationId,
    controllerId: wait.controllerId,
    version: wait.version,
    joinedAtMs: wait.joinedAtMs,
    expiresAtMs: group?.expiresAtMs ?? wait.expiresAtMs,
  };
  if (!group && controllerId === wait.controllerId) {
    const estimatedMatchAtMs = estimatedMatchAt(r, state, wait, now, cpuSeats);
    if (estimatedMatchAtMs !== undefined) result.estimatedMatchAtMs = estimatedMatchAtMs;
  }
  if (group) await assignCredential(r, state, group, wait, accountId, controllerId, result);
  return result;
}

export async function status(
  r: MatchmakingRuntime,
  state: State,
  accountId: string | null,
  controllerId?: string,
  includeWaitingInfo = true,
) {
  return snapshot(r, state, accountId, controllerId, true, includeWaitingInfo);
}

export async function previousRoom(state: State, accountId: string, matchId: string) {
  const group = state.groups.find(
    (group) =>
      group.id === matchId && group.players.some((player) => player.accountId === accountId),
  );
  return group ? { roomId: group.roomId, instanceId: group.instanceId } : null;
}

async function assignCredential(
  r: MatchmakingRuntime,
  state: State,
  group: Group,
  wait: Wait,
  accountId: string,
  controllerId: string | undefined,
  result: MatchmakingState,
) {
  if (
    group &&
    ["matched", "playing"].includes(group.phase) &&
    controllerId === wait.controllerId &&
    !("credentialPending" in wait && wait.credentialPending)
  ) {
    const player = group.players.find((p) => p.accountId === accountId)!;
    const credential = await r.credential(wait, state.key);
    result.assignment = {
      matchId: group.id,
      roomId: group.roomId,
      instanceId: group.instanceId,
      expiresAtMs: group.expiresAtMs,
      ...(group.rating ? { opponent: ratingOpponentKind(group.rating) } : {}),
      membership: {
        playerId: player.admission.playerId,
        role: group.players[0]?.accountId === accountId ? "host" : "player",
        token: credential.token,
      },
    };
  }
}
