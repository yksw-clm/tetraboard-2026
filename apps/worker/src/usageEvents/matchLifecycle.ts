import type { FinishedFor } from "../rooms/gameProgress";
import type { GameId } from "@tetraboard/protocol";

export function matchEndFacts(game: FinishedFor<GameId>) {
  return { reason: game.result?.reason ?? "unknown" };
}
