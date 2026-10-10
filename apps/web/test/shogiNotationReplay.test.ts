import { afterEach, expect, test } from "bun:test";
import * as shogi from "@tetraboard/shogi";
import * as four from "@tetraboard/four-shogi";
import { fixture, move } from "../../../packages/four-shogi/bench/positionFixture";
import { createShogiReplayFrame, shogiReplayV1 } from "../src/features/room/standardShogiReplayV1";
import {
  createFourShogiReplayFrame,
  fourShogiReplayV1,
} from "../src/features/room/fourShogiReplayV1";
import { fetchEventReplay } from "../src/features/room/fetchEventReplay";
import type { FourShogiReplayEvent, ShogiReplayEvent } from "@tetraboard/protocol";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("通常将棋の実着手で▲7六歩・△3四歩・角成・同銀を生成する", () => {
  let state = shogi.createInitialState({ players: { south: "s", north: "n" } });
  const labels: string[] = [];
  const names: (string | undefined)[] = [];
  for (const action of [
    move("C7", "C6"),
    move("G3", "G4"),
    move("B8", "H2", true),
    move("G1", "H2"),
  ]) {
    if (state.status !== "playing") throw Error("Expected playing state");
    const event = { type: "action", side: state.turn, action } as ShogiReplayEvent;
    const before = state;
    const result = shogiReplayV1.applyEvent(before, event);
    if (!result.ok) throw Error(result.reason);
    state = result.state;
    const frame = createShogiReplayFrame(state, { before, event });
    labels.push(frame.label);
    names.push(frame.accessibleLabel);
  }
  expect(labels).toEqual(["1: ▲7六歩", "2: △3四歩", "3: ▲2二角成", "4: △同銀"]);
  expect(names).toEqual(["1: 先手7六歩", "2: 後手3四歩", "3: 先手2二角成", "4: 後手同銀"]);
});

test("王手放置になる同種駒は曖昧さの候補から除く", () => {
  const base = shogi.createInitialState({ players: { south: "s", north: "n" } });
  const board: (shogi.Piece | null)[][] = Array.from({ length: 9 }, () => Array(9).fill(null));
  const pieces = [
    { side: "south", kind: "king", x: 3, y: 8 },
    { side: "north", kind: "king", x: 8, y: 0 },
    { side: "north", kind: "rook", x: 3, y: 0 },
    { side: "south", kind: "gold", x: 3, y: 7 },
    { side: "south", kind: "gold", x: 5, y: 7 },
  ] as const;
  pieces.forEach((piece, id) => {
    board[piece.y][piece.x] = { id, side: piece.side, kind: piece.kind, promoted: false };
  });
  const before: shogi.ShogiState = { ...base, board, nextPieceId: 10, repetitions: {} };
  const action = move("F8", "E7") as shogi.ShogiAction;
  expect(shogi.getLegalActions(before)).not.toContainEqual(move("D8", "E7"));
  const result = shogi.applyAction(before, "south", action);
  if (!result.ok) throw Error(result.reason);
  expect(
    createShogiReplayFrame(result.state, {
      before,
      event: { type: "action", side: "south", action },
    }).label,
  ).toBe("1: ▲5七金");
});

for (const mode of ["singles", "doubles"] as const)
  for (const side of four.sides) {
    test(`${mode}/${side}: 実合法手から各陣営基準の左右を生成する`, () => {
      const locations = {
        south: ["D9", "F9", "E8", "1: 南5八金左"],
        west: ["A4", "A6", "B5", "1: 西8五金左"],
        north: ["F1", "D1", "E2", "1: 北5二金左"],
        east: ["I6", "I4", "H5", "1: 東2五金左"],
      } as const;
      const [left, right, to, expected] = locations[side];
      const before = fixture({
        mode,
        turn: side,
        pieces: [
          { side, kind: "gold", at: left },
          { side, kind: "gold", at: right },
        ],
      });
      const original = JSON.stringify(before);
      const action = move(left, to);
      const result = four.applyAction(before, side, action);
      if (!result.ok) throw Error(result.reason);
      expect(
        createFourShogiReplayFrame(result.state, {
          before,
          event: { type: "action", side, action },
        }).label,
      ).toBe(expected);
      expect(JSON.stringify(before)).toBe(original);
    });
  }

test("三人攻撃禁止で成りだけが不正な移動には不成を付けない", () => {
  const before = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "pawn", at: "D4" },
      { side: "west", kind: "gold", at: "E2" },
    ],
    attackRelations: ["north", "east"].map((attacker) => ({
      attacker: attacker as four.Side,
      target: "west" as const,
      reasons: ["check" as const],
      targetPieceIds: [],
      pendingSides: ["south", "west", "north", "east"] as four.Side[],
    })),
  });
  const availability = four.getActionAvailability(before);
  expect(availability.threePlayerAttackForbiddenActions).toContainEqual(move("D4", "D3", true));
  const action = move("D4", "D3");
  const result = four.applyAction(before, "south", action);
  if (!result.ok) throw Error(result.reason);
  expect(
    createFourShogiReplayFrame(result.state, {
      before,
      event: { type: "action", side: "south", action },
    }).label,
  ).toBe("1: 南6三歩");
});

for (const mode of ["singles", "doubles"] as const)
  for (const side of four.sides) {
    test(`${mode}/${side}: 3枚の龍の中央縦移動だけ直を使い、移動元の括弧は使わない`, () => {
      const locations = {
        south: ["D7", "E7", "F7", "E6", "5六"],
        west: ["C4", "C5", "C6", "D5", "6五"],
        north: ["F3", "E3", "D3", "E4", "5四"],
        east: ["G6", "G5", "G4", "F5", "4五"],
      } as const;
      const [left, middle, right, to, destination] = locations[side];
      const before = fixture({
        mode,
        turn: side,
        pieces: [left, middle, right].map((at) => ({ side, kind: "rook", promoted: true, at })),
      });
      const labels = [];
      for (const from of [left, middle, right]) {
        const action = move(from, to);
        const next = four.applyAction(before, side, action);
        if (!next.ok) throw Error(next.reason);
        labels.push(
          createFourShogiReplayFrame(next.state, {
            before,
            event: { type: "action", side, action },
          }).label,
        );
      }
      const mark = { south: "南", west: "西", north: "北", east: "東" }[side];
      expect(labels).toEqual([
        `1: ${mark}${destination}龍左`,
        `1: ${mark}${destination}龍直`,
        `1: ${mark}${destination}龍右`,
      ]);
    });
  }

test("4枚の龍の上下からの縦移動には直上・直引を付ける", () => {
  const before = fixture({
    pieces: ["D6", "E6", "E4", "F4"].map((at) => ({
      side: "south",
      kind: "rook",
      promoted: true,
      at,
    })),
  });
  const labels = [];
  for (const from of ["D6", "E6", "E4", "F4"]) {
    const action = move(from, "E5");
    const next = four.applyAction(before, "south", action);
    if (!next.ok) throw Error(next.reason);
    labels.push(
      createFourShogiReplayFrame(next.state, {
        before,
        event: { type: "action", side: "south", action },
      }).label,
    );
  }
  expect(labels).toEqual(["1: 南5五龍左", "1: 南5五龍直上", "1: 南5五龍直引", "1: 南5五龍右"]);
});

test("ページ境界・提案取消・外部脱落を挟んでも直前の着手を同の基準にする", async () => {
  const initial = fixture({
    pieces: [
      { side: "south", kind: "pawn", at: "E7" },
      { side: "west", kind: "silver", at: "D5" },
    ],
  });
  const events: FourShogiReplayEvent[] = [
    { type: "action", side: "south", action: move("E7", "E6") },
    { type: "drawProposal", side: "west", proposed: true },
    { type: "drawProposal", side: "west", proposed: false },
    { type: "eliminate", side: "north", reason: "timeout" },
    { type: "action", side: "west", action: move("D5", "E6") },
    { type: "eliminate", side: "east", reason: "left" },
    { type: "eliminate", side: "south", reason: "timeout" },
  ];
  let final = initial;
  for (const event of events) {
    const next = fourShogiReplayV1.applyEvent(final, event);
    if (!next.ok) throw Error(next.reason);
    final = next.state;
  }
  const { repetitions: _repetitions, ...finalGame } = final;
  globalThis.fetch = (async (input) => {
    const cursor = Number(
      new URL(String(input), "https://example.test").searchParams.get("cursor"),
    );
    return Response.json({
      initial,
      eventCount: events.length,
      events: events
        .slice(cursor, cursor + 2)
        .map((event, index) => ({ index: cursor + index, event })),
      nextCursor: cursor + 2 < events.length ? cursor + 2 : null,
    });
  }) as typeof fetch;
  const frames = await fetchEventReplay({
    signal: new AbortController().signal,
    path: (cursor) => `/replay?cursor=${cursor}`,
    parsePage: (value) =>
      value as {
        initial: four.FourShogiState;
        eventCount: number;
        events: { index: number; event: FourShogiReplayEvent }[];
        nextCursor: number | null;
      },
    validateInitial: () => true,
    rules: { ...fourShogiReplayV1, initialize: (state: four.FourShogiState) => state },
    finalGame,
  });
  expect(frames.map((frame) => frame.label)).toEqual([
    "開始局面",
    "1: 南5六歩",
    "西 引分提案",
    "西 引分取消",
    "北 時間切れ",
    "2: 西同銀",
    "東 退室",
    "南 時間切れ",
  ]);
  expect(frames.at(-1)?.game).toEqual(finalGame);
});
