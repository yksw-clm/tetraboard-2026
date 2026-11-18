import type {
  FourReversiAccountStats,
  FourShogiAccountStats,
  RoomMode,
} from "@tetraboard/protocol";

export type RankedOutcomeTotals = FourReversiAccountStats["singles"] &
  FourReversiAccountStats["doubles"] & {
    mode: RoomMode;
    knockouts: number;
    perfectWins: number;
  };

export function summarizeRankedOutcomes(rows: RankedOutcomeTotals[]) {
  const stats: FourReversiAccountStats = {
    singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0 },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  };
  for (const row of rows) {
    if (row.mode === "singles") {
      const { total, first, second, third, fourth } = row;
      stats.singles = { total, first, second, third, fourth };
    } else if (row.mode === "doubles") {
      const { total, wins, losses, draws } = row;
      stats.doubles = { total, wins, losses, draws };
    }
  }
  return stats;
}

export function summarizeFourShogiOutcomes(rows: RankedOutcomeTotals[]): FourShogiAccountStats {
  const stats = summarizeRankedOutcomes(rows);
  const singles = rows.find((row) => row.mode === "singles");
  return {
    ...stats,
    singles: {
      ...stats.singles,
      knockouts: singles?.knockouts ?? 0,
      perfectWins: singles?.perfectWins ?? 0,
    },
  };
}
