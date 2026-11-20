import type { FinishedFor } from "../adapters/room/games/gameProgress";
import type { GameId } from "@tetraboard/protocol";

export function matchEndFacts(game: FinishedFor<GameId>) {
  return { reason: game.result?.reason ?? "unknown" };
}
