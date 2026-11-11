import { expect, test } from "bun:test";
import { gameIds } from "../src/games";
import { roomMatchKind } from "../src/matchKinds";

test("通常対局は全ゲームで共通とし、CPUの有無で種別を変えない", () => {
  for (const game of gameIds) expect(roomMatchKind({ settings: { game } })).toBe("normal");
});
test("四人ゲームは成立時のratedフラグを使い、旧ランダムマッチをレート戦にしない", () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    expect(roomMatchKind({ settings: { game }, matchmaking: {} })).toBe(
      game === "four-reversi" ? "normal" : "unknown",
    );
    expect(roomMatchKind({ settings: { game }, matchmaking: { rated: true } })).toBe("rated");
  }
});
test("二人ゲームのレート戦は人間とCPU補充のどちらも同じ種別になる", () => {
  for (const game of ["reversi", "shogi"] as const)
    for (const opponent of ["human", "cpu"] as const)
      expect(roomMatchKind({ settings: { game }, matchmaking: { opponent } })).toBe("rated");
});
test("大会の成立情報を使い、矛盾があれば種別不明にする", () => {
  for (const game of ["four-reversi", "four-shogi", "four-gomoku"] as const)
    expect(roomMatchKind({ settings: { game }, tournamentId: 1 })).toBe("tournament");
  expect(
    roomMatchKind({
      settings: { game: "four-shogi" },
      tournamentId: 1,
      matchmaking: { rated: true },
    }),
  ).toBe("unknown");
});
