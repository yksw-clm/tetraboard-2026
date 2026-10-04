import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createRoomContract,
  listRoomsContract,
  listMatchesContract,
  getAccountStatsContract,
  roomTimeControl,
  isFourShogiRoom,
  type RoomMode,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { boundaryJson, boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";

const selectors = [
  { label: "省略", game: undefined, expected: "four-reversi" },
  { label: "明示リバーシ", game: "four-reversi", expected: "four-reversi" },
  { label: "明示将棋", game: "four-shogi", expected: "four-shogi" },
] as const;
const invalidGames = ["unknown-game", ""];
const modes = ["singles", "doubles"] as const;

function queryFor(game: string | undefined, mode?: RoomMode) {
  const query = new URLSearchParams();
  if (game !== undefined) query.set("game", game);
  if (mode !== undefined) query.set("mode", mode);
  return query;
}

async function roomList(game?: string) {
  const rooms: RoomPublicMetadata[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = queryFor(game);
    if (cursor !== null) query.set("cursor", cursor);
    const response = await boundaryRequest(`/rooms?${query}`);
    expect(response.status).toBe(200);
    const page = listRoomsContract.response.parse(await response.json());
    rooms.push(...page.rooms);
    cursor = page.nextCursor;
    if (cursor !== null) {
      expect(seenCursors.has(cursor)).toBe(false);
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  expect(new Set(rooms.map((room) => room.id)).size).toBe(rooms.length);
  return rooms;
}

describe("ゲーム境界: 作成・一覧", () => {
  let fixtures: RoomBoundaryFixtures;
  beforeEach(() => {
    fixtures = new RoomBoundaryFixtures();
  });
  afterEach(async () => {
    await fixtures.dispose();
  });

  for (const selector of selectors) {
    for (const mode of modes) {
      for (const quickPlay of [false, true]) {
        test(`作成: ${selector.label}・${mode}・${quickPlay ? "すぐ遊ぶ" : "通常"}`, async () => {
          const { room, membership } = await fixtures.create({
            name: "境界ホスト",
            mode,
            quickPlay,
            ...(selector.game === undefined ? {} : { game: selector.game }),
          });
          expect(room.settings.game).toBe(selector.expected);
          expect(room.settings.mode).toBe(mode);
          expect(room.settings.timeControl).toEqual(roomTimeControl);
          expect(room.status).toBe("waiting");
          expect(room.game).toBeNull();
          expect(room.clock).toBeNull();
          expect(room.lastRound).toBeNull();
          expect(room.players).toHaveLength(quickPlay ? 4 : 1);
          expect(membership.role).toBe("host");
          expect(room.players[0]).toMatchObject({
            id: membership.playerId,
            name: "境界ホスト",
            kind: "human",
            ready: quickPlay,
          });
          expect(room.players.filter((player) => player.kind === "human")).toHaveLength(1);
          expect(room.players.slice(1)).toEqual(
            quickPlay
              ? [1, 2, 3].map((index) =>
                  expect.objectContaining({
                    name: `CPU ${index}`,
                    kind: "cpu",
                    level: 1,
                    ready: true,
                  }),
                )
              : [],
          );
          for (const player of room.players) {
            expect(player).toHaveProperty(
              selector.expected === "four-shogi" ? "side" : "color",
              null,
            );
            expect(player).not.toHaveProperty(
              selector.expected === "four-shogi" ? "color" : "side",
            );
          }
          if (isFourShogiRoom(room)) {
            expect(room.settings.threePlayerAttackProhibited).toBe(true);
            expect(room).toMatchObject({
              roundId: null,
              positionRevision: 0,
              legalActions: [],
              threePlayerAttackForbiddenActions: [],
              checkState: { south: false, west: false, north: false, east: false },
            });
          } else {
            expect(room.settings).not.toHaveProperty("threePlayerAttackProhibited");
            expect(room).not.toHaveProperty("roundId");
          }
          expect((await fixtures.snapshot(room.id)).room).toEqual(room);
        });
      }
    }

    test(`一覧: ${selector.label}は対象ゲームだけを返す`, async () => {
      const reversi = await fixtures.create({
        name: "リバーシ",
        mode: "singles",
        quickPlay: false,
        game: "four-reversi",
      });
      const shogi = await fixtures.create({
        name: "将棋",
        mode: "singles",
        quickPlay: false,
        game: "four-shogi",
      });
      const rooms = await roomList(selector.game);
      const expected = selector.expected === "four-shogi" ? shogi : reversi;
      const excluded = selector.expected === "four-shogi" ? reversi : shogi;
      expect(rooms.map((room) => room.id)).toContain(expected.room.id);
      expect(rooms.map((room) => room.id)).not.toContain(excluded.room.id);
      expect(rooms.every((room) => room.game === selector.expected)).toBe(true);
    });
  }

  for (const game of [...invalidGames, null]) {
    test(`作成: 不正game ${JSON.stringify(game)}を拒否してルームを増やさない`, async () => {
      await fixtures.create({ name: "既存", mode: "singles", quickPlay: false });
      const before = (await Promise.all([roomList("four-reversi"), roomList("four-shogi")]))
        .flat()
        .map((room) => room.id)
        .sort();
      const response = await boundaryRequest(
        "/rooms",
        boundaryJson({ name: "不正", mode: "singles", quickPlay: false, game }),
      );
      expect(response.status).toBe(400);
      expect(createRoomContract.error.parse(await response.json())).toEqual({
        error: "invalid_request",
      });
      const after = (await Promise.all([roomList("four-reversi"), roomList("four-shogi")]))
        .flat()
        .map((room) => room.id)
        .sort();
      expect(after).toEqual(before);
    });
  }

  for (const game of invalidGames) {
    test(`一覧: 不正game ${JSON.stringify(game)}を拒否する`, async () => {
      const response = await boundaryRequest(`/rooms?${queryFor(game)}`);
      expect(response.status).toBe(400);
      expect(listRoomsContract.error.parse(await response.json())).toEqual({
        error: "invalid_request",
      });
    });
  }
});

describe("ゲーム境界: 本人の履歴・戦績", () => {
  let user: Awaited<ReturnType<typeof accountFixture>>;
  const users: Awaited<ReturnType<typeof accountFixture>>[] = [];
  const records: { id: string; game: string; mode: RoomMode; own: boolean }[] = [];

  beforeAll(async () => {
    user = await accountFixture();
    const other = await accountFixture();
    users.push(user, other);
    let index = 0;
    for (const account of users) {
      for (const [game, counts] of [
        ["four-reversi", [1, 2]],
        ["four-shogi", [3, 4]],
      ] as const) {
        for (const [modeIndex, mode] of modes.entries()) {
          for (let at = 0; at < (account === user ? counts[modeIndex] : 1); at++) {
            if (game === "four-reversi") {
              const record = humanFixtureRecord(account.id, ++index, mode);
              await writeMatch(env.APP_DB, record);
              records.push({ id: record.id, game, mode, own: account === user });
            } else {
              const fixture = humanShogiRecord(account.id, "south", mode);
              await saveShogiFixture(fixture);
              records.push({ id: fixture.record.id, game, mode, own: account === user });
            }
          }
        }
      }
    }
  });

  afterAll(async () => {
    for (const { id } of records) {
      await env.APP_DB.batch([
        env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
        env.APP_DB.prepare("DELETE FROM shogi_match_chunks WHERE match_id = ?").bind(id),
        env.APP_DB.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(id),
        env.APP_DB.prepare("DELETE FROM matches WHERE id = ?").bind(id),
      ]);
    }
    for (const account of users) {
      await env.APP_DB.batch([
        env.APP_DB.prepare("DELETE FROM session WHERE userId = ?").bind(account.id),
        env.APP_DB.prepare("DELETE FROM user WHERE id = ?").bind(account.id),
      ]);
    }
  });

  for (const selector of selectors) {
    for (const mode of modes) {
      test(`履歴: ${selector.label}・${mode}は本人の対象ゲーム・モードのみ`, async () => {
        const response = await boundaryRequest(
          `/account/matches?${queryFor(selector.game, mode)}`,
          { headers: { Cookie: user.cookie } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const page = listMatchesContract.response.parse(await response.json());
        const expected = records.filter(
          (record) => record.own && record.game === selector.expected && record.mode === mode,
        );
        expect(page.matches.map((match) => match.id).sort()).toEqual(
          expected.map((record) => record.id).sort(),
        );
        expect(
          page.matches.every((match) => match.game === selector.expected && match.mode === mode),
        ).toBe(true);
        expect(page.nextCursor).toBeNull();
      });
    }

    test(`戦績: ${selector.label}は本人の対象ゲームだけを集計する`, async () => {
      const response = await boundaryRequest(`/account/stats?${queryFor(selector.game)}`, {
        headers: { Cookie: user.cookie },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const stats = getAccountStatsContract.response.parse(await response.json());
      expect(stats).toEqual(
        selector.expected === "four-reversi"
          ? {
              singles: { total: 1, first: 0, second: 0, third: 0, fourth: 1 },
              doubles: { total: 2, wins: 0, losses: 2, draws: 0 },
            }
          : {
              singles: { total: 3, first: 3, second: 0, third: 0, fourth: 0, knockouts: 0 },
              doubles: { total: 4, wins: 4, losses: 0, draws: 0 },
            },
      );
    });
  }

  for (const game of invalidGames) {
    for (const endpoint of ["matches", "stats"] as const) {
      test(`${endpoint}: 不正game ${JSON.stringify(game)}を既定ゲームへ流さず拒否する`, async () => {
        const response = await boundaryRequest(
          `/account/${endpoint}?${queryFor(game, endpoint === "matches" ? "singles" : undefined)}`,
          { headers: { Cookie: user.cookie } },
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({
          message:
            endpoint === "matches"
              ? "履歴の取得条件が正しくありません。"
              : "戦績の取得条件が正しくありません。",
        });
      });
    }
  }
});
