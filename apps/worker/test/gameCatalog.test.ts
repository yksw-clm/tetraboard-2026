import { describe, expect, expectTypeOf, test } from "vitest";
import {
  gameIds,
  gameCatalog,
  isGameId,
  isGameScope,
  type GameId,
  type GameScope,
} from "@tetraboard/protocol/games";
import {
  gameIdSchema,
  gameScopeSchema,
  matchGameSchema,
  analyticsGameSchema,
  feedbackGameSchema,
  adminAnalyticsQuerySchema,
  pageViewInputSchema,
  listMatchesContract,
  getAccountStatsContract,
} from "@tetraboard/protocol";
import { roomGameSchema } from "../../../packages/protocol/src/rooms";

describe("ゲームIDとサービス全体の対象", () => {
  test("all はゲームとして扱わず、サービス全体の対象だけで受理する", () => {
    expectTypeOf<Extract<GameId, "all">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<GameScope, "all">>().toEqualTypeOf<"all">();
    for (const schema of [gameIdSchema, roomGameSchema, matchGameSchema, analyticsGameSchema])
      expect(schema.safeParse("all").success).toBe(false);
    expect(isGameId("all")).toBe(false);
    expect(isGameScope("all")).toBe(true);
    expect(gameScopeSchema.parse("all")).toBe("all");
    expect(feedbackGameSchema.parse("all")).toBe("all");
    expect(
      adminAnalyticsQuerySchema.parse({ from: "2026-10-01", to: "2026-10-04", game: "all" }).game,
    ).toBe("all");
    expect(
      pageViewInputSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        page: "lobby",
        game: "all",
      }).success,
    ).toBe(false);
  });

  test.each(gameIds)("%s は各ゲーム入口と対象入口で受理する", (game) => {
    expect(isGameId(game)).toBe(true);
    expect(isGameScope(game)).toBe(true);
    for (const schema of [
      gameIdSchema,
      roomGameSchema,
      matchGameSchema,
      analyticsGameSchema,
      feedbackGameSchema,
    ])
      expect(schema.parse(game)).toBe(game);
  });

  test.each(["unknown-game", "", null, undefined])(
    "不正なID %s を既定ゲームへ流さない",
    (value) => {
      expect(isGameId(value)).toBe(false);
      expect(isGameScope(value)).toBe(false);
      expect(gameIdSchema.safeParse(value).success).toBe(false);
      expect(gameScopeSchema.safeParse(value).success).toBe(false);
    },
  );

  test("ゲーム省略時の履歴・戦績と集計の既定値を維持する", () => {
    expect(listMatchesContract.query.parse({ mode: "singles" }).game).toBe("four-reversi");
    expect(getAccountStatsContract.query.parse({}).game).toBe("four-reversi");
    expect(adminAnalyticsQuerySchema.parse({ from: "2026-10-01", to: "2026-10-04" }).game).toBe(
      "all",
    );
  });

  test("選択順・表示名・公開パスを維持し、サービス全体をゲームに表示しない", () => {
    expect(gameIds.map((id) => ({ id, ...gameCatalog[id] }))).toEqual([
      {
        capacity: 4,
        hasModes: true,
        id: "four-reversi",
        name: "四人リバーシ",
        lobbyPath: "/games/four-reversi",
        rankingsPath: "/games/four-reversi/rankings",
      },
      {
        capacity: 4,
        hasModes: true,
        id: "four-shogi",
        name: "四人将棋",
        lobbyPath: "/games/four-shogi",
        rankingsPath: "/games/four-shogi/rankings",
      },
      {
        id: "reversi",
        name: "リバーシ",
        lobbyPath: "/games/reversi",
        rankingsPath: "/games/reversi/rankings",
        capacity: 2,
        hasModes: false,
      },
      {
        id: "shogi",
        name: "将棋",
        lobbyPath: "/games/shogi",
        rankingsPath: "/games/shogi/rankings",
        capacity: 2,
        hasModes: false,
      },
      {
        id: "gomoku",
        name: "五目並べ",
        lobbyPath: "/games/gomoku",
        rankingsPath: "/games/gomoku/rankings",
        capacity: 2,
        hasModes: false,
      },
    ]);
  });
});
