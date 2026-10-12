import type { PlayerProfile, RoomMode } from "@tetraboard/protocol";
import { formatStatsRate } from "../account/statsPresentation";

type ProfileStats = Extract<PlayerProfile, { kind: "account" }>["stats"];

export function formatPlayerStatsSummary(stats: ProfileStats, mode: RoomMode): string {
  if (!("wins" in stats) && mode === "singles") {
    const singles = stats.singles;
    let summary = `${singles.total}局 ${singles.first}優勝 (${formatStatsRate(singles.first, singles.total)})`;
    if ("second" in singles) {
      const average =
        singles.total === 0
          ? "—"
          : (
              (singles.first + singles.second * 2 + singles.third * 3 + singles.fourth * 4) /
              singles.total
            ).toFixed(2);
      summary += ` 平均${average}位`;
    }
    if ("knockouts" in singles) summary += ` ${singles.knockouts}撃破`;
    return summary;
  }
  const result = "wins" in stats ? stats : stats.doubles;
  const outcomes =
    "losses" in result && "draws" in result
      ? `${result.wins}勝${result.losses}敗${result.draws}分`
      : `${result.wins}勝`;
  return `${result.total}局 ${outcomes} (${formatStatsRate(result.wins, result.total)})`;
}
