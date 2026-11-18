import type {
  FourReversiAccountStats,
  FourShogiAccountStats,
  FourShogiFormationStats,
  MatchGame,
  ReversiAccountStats,
} from "@tetraboard/protocol";
import {
  summarizeFourShogiOutcomes,
  summarizeRankedOutcomes,
  type RankedOutcomeTotals,
} from "../domain/accountStats";

type RankedGame = "four-gomoku" | "four-reversi" | "four-shogi";
type DuelGame = Exclude<MatchGame, RankedGame>;
type OutcomeStats<G extends MatchGame> = G extends "four-shogi"
  ? FourShogiAccountStats
  : G extends RankedGame
    ? FourReversiAccountStats
    : ReversiAccountStats | null;

export interface OutcomeStatsReader {
  ranked(game: RankedGame, accountId: string): Promise<RankedOutcomeTotals[]>;
  duel(game: DuelGame, accountId: string): Promise<ReversiAccountStats | null>;
}

export function readAccountStats<G extends MatchGame>(
  reader: OutcomeStatsReader,
  accountId: string,
  game: G,
): Promise<OutcomeStats<G>>;
export async function readAccountStats(
  reader: OutcomeStatsReader,
  accountId: string,
  game: MatchGame,
) {
  switch (game) {
    case "shogi":
    case "gomoku":
    case "reversi":
      return reader.duel(game, accountId);
    case "four-gomoku":
    case "four-reversi":
      return summarizeRankedOutcomes(await reader.ranked(game, accountId));
    case "four-shogi":
      return summarizeFourShogiOutcomes(await reader.ranked(game, accountId));
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported stats game: ${exhaustive}`);
    }
  }
}

export interface FormationStatsReader {
  readFormations(accountId: string): Promise<FourShogiFormationStats>;
}

export async function readFormationStats(
  reader: FormationStatsReader,
  accountId: string,
  formationIds: readonly string[],
): Promise<FourShogiFormationStats> {
  const rows = await reader.readFormations(accountId);
  if (rows.some((entry) => !formationIds.some((id) => id === entry.id)))
    throw new Error("Unknown Shogi formation ID");
  return rows;
}
