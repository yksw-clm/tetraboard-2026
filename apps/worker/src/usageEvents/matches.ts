import type { MatchKind } from "@tetraboard/protocol";
export type AnalyticsIdentity = {
  visitorId: string | null;
  accountId: string | null;
  isTest: boolean;
  isGuest?: boolean;
};
export type AnalyticsMatch = {
  id: string;
  game: string;
  mode: string;
  startedAtMs: number;
  endedAtMs: number | null;
  status: "playing" | "completed" | "abandoned";
  cpuCount: number;
  matchKind?: MatchKind;
  humanCount?: number;
  participants: (AnalyticsIdentity & {
    playerId: string;
    search?: { operationId: string; joinedAtMs: number };
  })[];
};
// 進行中の局と席を引き継ぐため、保存キーは既存の名前を保ちます。
export const analyticsActiveKey = "analytics-active";
export const analyticsPlayerKey = (id: string) => `analytics-player:${id}`;
