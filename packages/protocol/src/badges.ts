import type { GameId } from "./games";
import type { AccountStats } from "./matches";

export const badgeIds = ["games", "wins", "knockouts", "perfect-wins"] as const;
export type BadgeId = (typeof badgeIds)[number];
export type BadgeTier = 0 | 1 | 2 | 3;
export type EarnedBadge = { id: BadgeId; tier: 1 | 2 | 3; value: number };
export type BadgeProgress = {
  id: BadgeId;
  tier: BadgeTier;
  value: number;
  nextThreshold: number | null;
};

export const badgeDefinitions = {
  games: { name: "対局数", unit: "局", thresholds: [5, 20, 100], condition: "対人戦で対局する" },
  wins: {
    name: "優勝数",
    unit: "回",
    thresholds: [3, 15, 50],
    condition: "対人戦で優勝する（同率優勝を含む）",
  },
  knockouts: {
    name: "撃破数",
    unit: "人",
    thresholds: [3, 15, 50],
    condition: "対人戦で相手を詰ませて撃破する",
  },
  "perfect-wins": {
    name: "完全優勝",
    unit: "回",
    thresholds: [1, 2, 3],
    condition: "対人戦で他の3人全員を撃破して単独優勝する",
  },
} as const satisfies Record<
  BadgeId,
  { name: string; unit: string; thresholds: readonly [number, number, number]; condition: string }
>;

export function getBadgeIds(game: GameId): readonly BadgeId[] {
  if (game === "reversi" || game === "shogi") return [];
  return game === "four-shogi" ? badgeIds : ["games", "wins"];
}

export function getBadgeProgress(game: GameId, stats: AccountStats): BadgeProgress[] {
  if (!("singles" in stats)) return [];
  const singles = stats.singles;
  return getBadgeIds(game).map((id) => {
    const value =
      id === "games"
        ? singles.total
        : id === "wins"
          ? singles.first
          : "knockouts" in singles
            ? id === "knockouts"
              ? singles.knockouts
              : singles.perfectWins
            : 0;
    const thresholds = badgeDefinitions[id].thresholds;
    const tier = thresholds.filter((threshold) => value >= threshold).length as BadgeTier;
    return { id, tier, value, nextThreshold: tier === 3 ? null : thresholds[tier] };
  });
}

export function getEarnedBadges(game: GameId, stats: AccountStats): EarnedBadge[] {
  return getBadgeProgress(game, stats).flatMap(({ id, tier, value }) =>
    tier === 0 ? [] : [{ id, tier, value }],
  );
}
