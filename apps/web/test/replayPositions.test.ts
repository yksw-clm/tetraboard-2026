import { expect, spyOn, test } from "bun:test";
import {
  publicFourGomokuMatchDetailSchema,
  publicFourReversiMatchDetailSchema,
  publicFourShogiMatchDetailSchema,
  publicGomokuMatchDetailSchema,
  publicReversiMatchDetailSchema,
} from "@tetraboard/protocol";
import fourGomokuArchive from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import fourReversiArchive from "../../../test-fixtures/matches/reversi-doubles-normal.json";
import fourShogiArchive from "../../../test-fixtures/matches/shogi-singles.json";
import gomokuArchive from "../../../test-fixtures/matches/gomoku-on-five.json";
import reversiArchive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { fourGomokuReplayFrames } from "../src/features/room/fourGomokuReplay";
import { fetchFourShogiMatchReplay } from "../src/features/room/fourShogiMatchReplay";
import { gomokuReplayFrames } from "../src/features/room/gomokuReplay";
import { replayFrames } from "../src/features/room/replayFrames";
import { reversiReplayFrames } from "../src/features/room/reversiReplay";
import { fetchShogiMatchReplay } from "../src/features/room/standardShogiMatchReplay";
import { standardSavedRound } from "./fixtures/standardShogiFixtures";

// 局面番号は棋譜 Select の位置（開始局面は 0）で、公開棋譜の ?position= と掲示板の添付に保存されます。
// このテストで並びの変更を検出したら、保存済みの URL と添付への影響を確認します。
test("四人リバーシの局面番号は自動パスを色ごとに数える", () => {
  const { selfPlayerId: _selfPlayerId, ...detail } = fourReversiArchive.detail;
  const match = publicFourReversiMatchDetailSchema.parse(detail);
  const frames = replayFrames({ ...match, players: match.participants });

  expect(match.replay.steps).toHaveLength(54);
  expect(frames.length - 1).toBe(63);
  expect(frames[0]?.label).toBe("開始局面");
  expect(frames[1]?.label).toBe("1: 黒C4");
  expect(frames[36]?.label).toBe("36: 青H5");
  expect(frames[37]?.label).toBe("黒 パス");
  expect(frames[59]?.label).toBe("54: 赤E8");
  expect(frames[60]?.label).toBe("青 パス");
  expect(frames[61]?.label).toBe("黒 パス");
  expect(frames[62]?.label).toBe("白 パス");
  expect(frames[63]?.label).toBe("赤 パス");
});

test("リバーシの局面番号は自動パスの後に最終着手を数える", () => {
  const match = publicReversiMatchDetailSchema.parse(reversiArchive.detail);
  const frames = reversiReplayFrames({ ...match, players: match.participants });

  expect(frames.length - 1).toBe(61);
  expect(frames[0]?.label).toBe("開始局面");
  expect(frames[1]?.label).toBe("1: 黒E6");
  expect(frames[59]?.label).toBe("59: 黒D8");
  expect(frames[60]?.label).toBe("白 パス");
  expect(frames[61]?.label).toBe("60: 黒A1");
});

test("五目並べの局面番号は開始から五連の完成までの着手順に並ぶ", () => {
  const match = publicGomokuMatchDetailSchema.parse(gomokuArchive.detail);
  const frames = gomokuReplayFrames({ ...match, players: match.participants });

  expect(frames.length - 1).toBe(9);
  expect(frames[0]?.label).toBe("開始局面");
  expect(frames[1]?.label).toBe("1: 黒 A8");
  expect(frames[2]?.label).toBe("2: 白 A1");
  expect(frames[9]?.label).toBe("9: 黒 E8");
});

test("四人五目並べの局面番号は最初の五連が完成した後も着手順に並ぶ", () => {
  const { selfPlayerId: _selfPlayerId, ...detail } = fourGomokuArchive.detail;
  const match = publicFourGomokuMatchDetailSchema.parse(detail);
  const frames = fourGomokuReplayFrames({ ...match, players: match.participants });

  expect(frames.length - 1).toBe(19);
  expect(frames[0]?.label).toBe("開始局面");
  expect(frames[1]?.label).toBe("1: 黒 A1");
  expect(frames[17]?.label).toBe("17: 黒 E1");
  expect(frames[18]?.label).toBe("18: 白 E3");
  expect(frames[19]?.label).toBe("19: 赤 E5");
});

function mockReplayPages(page: (cursor: number) => unknown) {
  return spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const url = new URL(String(input), "https://example.test");
    return Response.json(page(Number(url.searchParams.get("cursor"))));
  }) as typeof globalThis.fetch);
}

test("将棋の局面番号は開始から千日手の成立までの着手順に並ぶ", async () => {
  const { match: fixture, page } = standardSavedRound();
  const { selfPlayerId: _selfPlayerId, ...match } = fixture;
  const fetch = mockReplayPages(page);
  try {
    const frames = await fetchShogiMatchReplay(match, new AbortController().signal);

    expect(frames.length - 1).toBe(12);
    expect(frames[0]?.label).toBe("開始局面");
    expect(frames[1]?.label).toBe("1: ▲6八金");
    expect(frames[12]?.label).toBe("12: △6一金");
  } finally {
    fetch.mockRestore();
  }
});

test("四人将棋の局面番号は最終着手の後に各脱落を数える", async () => {
  const { selfPlayerId: _selfPlayerId, ...detail } = fourShogiArchive.detail;
  const match = publicFourShogiMatchDetailSchema.parse(detail);
  const fetch = mockReplayPages((cursor) => ({
    matchId: match.id,
    ...match.replay,
    events: fourShogiArchive.events.slice(cursor, cursor + 100),
    nextCursor: cursor + 100 < fourShogiArchive.events.length ? cursor + 100 : null,
  }));
  try {
    const frames = await fetchFourShogiMatchReplay(match, new AbortController().signal);

    expect(frames.length - 1).toBe(103);
    expect(frames[0]?.label).toBe("開始局面");
    expect(frames[1]?.label).toBe("1: 南5六歩");
    expect(frames[100]?.label).toBe("100: 西2九歩打");
    expect(frames[101]?.label).toBe("西 退室");
    expect(frames[102]?.label).toBe("東 時間切れ");
    expect(frames[103]?.label).toBe("南 退室");
  } finally {
    fetch.mockRestore();
  }
});
