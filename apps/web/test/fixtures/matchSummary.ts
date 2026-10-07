import type { MatchSummary } from "@tetraboard/protocol";
export function match(index: number, mode: "singles" | "doubles" = "singles"): MatchSummary {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    game: "four-reversi",
    mode,
    startedAtMs: Date.UTC(2026, 9, 2, 6, 30) - index * 60000,
    endedAtMs: Date.UTC(2026, 9, 2, 7, 30),
    participants: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "あいうえおかきくけこ",
        color: "black",
        seat: 0,
        kind: "human",
        avatarUrl: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "さしすせそたちつてと",
        color: "white",
        seat: 1,
        kind: "human",
        avatarUrl: null,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "CPU Lv1",
        color: "red",
        seat: 2,
        kind: "cpu",
        level: 1,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "CPU Lv2",
        color: "blue",
        seat: 3,
        kind: "cpu",
        level: 2,
      },
    ],
    result:
      mode === "singles"
        ? {
            mode,
            reason: "board_full",
            standings: [
              { color: "black", rank: 1, stoneCount: 20 },
              { color: "white", rank: 1, stoneCount: 20 },
              { color: "red", rank: 3, stoneCount: 15 },
              { color: "blue", rank: 4, stoneCount: 9 },
            ],
          }
        : {
            mode,
            reason: "board_full",
            winner: index % 2 === 0 ? "white-blue" : null,
            teamTotals: { "black-red": 32, "white-blue": 32 },
            stoneCounts: [
              { color: "black", count: 16 },
              { color: "white", count: 16 },
              { color: "red", count: 16 },
              { color: "blue", count: 16 },
            ],
          },
  };
}
