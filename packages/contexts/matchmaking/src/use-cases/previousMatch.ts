import type { MatchmakingState, RatedMatchmakingGame } from "@tetraboard/protocol";
import type { MatchmakingRoomState } from "./ports";
import { previousMatchState } from "../domain/previousMatch";
export type PendingMatch = {
  game: RatedMatchmakingGame;
  match_id: string;
  room_id: string | null;
  instance_id: string | null;
};
export interface PreviousMatchPorts {
  pending(accountId: string, game: RatedMatchmakingGame): Promise<PendingMatch | null>;
  previousRoom(
    accountId: string,
    pending: PendingMatch,
  ): Promise<{ roomId: string; instanceId: string } | null>;
  roomState(roomId: string, matchId: string, instanceId: string): Promise<MatchmakingRoomState>;
}
export async function previousMatch(
  ports: PreviousMatchPorts,
  accountId: string,
  game: RatedMatchmakingGame,
): Promise<MatchmakingState["previousMatch"]> {
  const pending = await ports.pending(accountId, game);
  if (!pending) return;
  const previous = { game: pending.game, matchId: pending.match_id };
  try {
    const reference =
      pending.room_id && pending.instance_id
        ? { roomId: pending.room_id, instanceId: pending.instance_id }
        : await ports.previousRoom(accountId, pending);
    if (!reference) return { ...previous, phase: "unavailable" };
    const state = await ports.roomState(reference.roomId, pending.match_id, reference.instanceId);
    return previousMatchState(previous, state);
  } catch {
    return { ...previous, phase: "unavailable" };
  }
}
