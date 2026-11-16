import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { PurgeTargets } from "./types";

export function rememberMatchPlayer(
  _runtime: RoomRuntime,
  targets: PurgeTargets,
  matchId: string,
  playerId: string,
) {
  const { matchPlayers } = targets;
  const players = matchPlayers.get(matchId) ?? new Set<string>();
  players.add(playerId);
  matchPlayers.set(matchId, players);
}

export function collectMatchPlayers(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  value: unknown,
): void {
  const { accountIds } = targets;
  if (Array.isArray(value)) {
    for (const item of value) collectMatchPlayers(runtime, targets, item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (typeof row.id === "string" && Array.isArray(row.participants)) {
    for (const participant of row.participants) {
      if (accountIds.has(participant?.accountId) && typeof participant.id === "string")
        rememberMatchPlayer(runtime, targets, row.id, participant.id);
    }
  }
  for (const item of Object.values(row)) collectMatchPlayers(runtime, targets, item);
}

export function identityScope(
  _runtime: RoomRuntime,
  targets: PurgeTargets,
  row: Record<string, unknown>,
  inherited?: ReadonlySet<string>,
) {
  const { accountIds, matchPlayers } = targets;
  if (Array.isArray(row.participants)) {
    const participants = row.participants as {
      id?: string;
      playerId?: string;
      accountId?: string;
      visitorId?: string;
    }[];
    const own = new Set(
      participants
        .filter((p) => accountIds.has(p.accountId ?? ""))
        .flatMap((p) => p.id ?? p.playerId ?? []),
    );
    if (!participants.some((p) => "visitorId" in p) && typeof row.id === "string")
      for (const id of matchPlayers.get(row.id) ?? []) own.add(id);
    return own;
  }
  if (row.game && Array.isArray(row.players)) {
    const replay = row.replay as { id?: unknown } | null | undefined;
    const matchId = typeof row.roundId === "string" ? row.roundId : replay?.id;
    if (typeof matchId === "string") return matchPlayers.get(matchId) ?? new Set<string>();
  }
  return inherited;
}
