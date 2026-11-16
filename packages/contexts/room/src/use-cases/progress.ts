import type { GameId, RoomFor } from "@tetraboard/protocol";
import type { ProgressFor } from "./gameProgress";
import type { RoomOperation } from "./ports";
import { rematchPlayers } from "./rematch";

export function applyProgress<G extends GameId>(
  op: RoomOperation,
  result: ProgressFor<G>,
): RoomFor<G> | null {
  switch (result.kind) {
    case "rejected":
      throw new Error(`Rejected progress: ${result.error}`);
    case "unchanged":
    case "playing":
      return result.room;
    case "finished":
      op.state.finishTournament(result.room);
      op.effects.push(...op.state.endMatchUsage("completed", result.at, result.game));
      return op.game(result.room).finish(result, (players, at) => rematchPlayers(op, players, at));
  }
}
