import { z } from "zod";
import type { GameId } from "./games";

export const matchKindSchema = z.enum(["rated", "tournament", "normal", "unknown"]);
export type MatchKind = z.infer<typeof matchKindSchema>;
export const matchKindQuerySchema = z.object({ includeMatchKind: z.literal("1").optional() });

export function roomMatchKind(room: {
  settings: { game: GameId };
  tournamentId?: number;
  matchmaking?: { rated?: true; opponent?: "human" | "cpu" };
}): MatchKind {
  const tournament = room.tournamentId !== undefined;
  const rated = Boolean(
    room.matchmaking &&
    (room.matchmaking.rated || room.settings.game === "shogi" || room.settings.game === "reversi"),
  );
  if (tournament && rated) return "unknown";
  if (tournament) return "tournament";
  if (room.matchmaking && room.settings.game === "four-shogi" && !rated) return "unknown";
  return rated ? "rated" : "normal";
}
