import { expect, test } from "bun:test";
import {
  encodeSnapshotMatch,
  rebuildSnapshotMatch,
  readMatchChunk,
  readMatchChunks,
  verifyFinalState,
  verifySnapshotReplay,
  type ChunkRow,
} from "../src";

const row = (index: number, count = 100): ChunkRow => ({
  chunk_index: index,
  start_index: index * 100,
  event_count: count,
  events_json: JSON.stringify(Array<number>(count).fill(index)),
});
const parse = (event: unknown) => {
  if (typeof event !== "number") throw new Error("Invalid event");
  return event;
};

test("100件境界と末尾の件数を検査し、チャンクを順に再生する", () => {
  expect(readMatchChunks([row(0), row(1, 1)], 101, parse)).toEqual([
    ...Array<number>(100).fill(0),
    1,
  ]);
  expect(readMatchChunks([], 0, parse)).toEqual([]);
  expect(readMatchChunk(row(0), 100, parse)).toHaveLength(100);
});

for (const [name, broken] of [
  ["負の番号", { chunk_index: -1 }],
  ["整数でない番号", { chunk_index: 0.5 }],
  ["開始位置", { start_index: 1 }],
  ["件数", { event_count: 99 }],
  ["イベント不足", { events_json: "[0]" }],
  ["配列以外", { events_json: "{}" }],
] as const) {
  test("不正なチャンクを拒否する: " + name, () => {
    expect(() => readMatchChunk({ ...row(0), ...broken }, 100, parse)).toThrow(
      "Match replay chunk is incomplete",
    );
  });
}
test("範囲外のチャンク、欠落、不連続、イベント検証の失敗を拒否する", () => {
  expect(() => readMatchChunk(row(1), 100, parse)).toThrow("Match replay chunk is incomplete");
  expect(() => readMatchChunks([row(0)], 101, parse)).toThrow("Missing match replay chunk");
  expect(() => readMatchChunks([row(1, 1), row(0)], 101, parse)).toThrow(
    "Match replay is not contiguous",
  );
  expect(() => readMatchChunk({ ...row(0, 1), events_json: '["invalid"]' }, 1, parse)).toThrow(
    "Invalid event",
  );
});

const snapshot = {
  id: "match",
  settings: { game: "four-gomoku" },
  game: { value: 2 },
  replay: {
    id: "replay",
    initial: { value: 0 },
    rulesVersion: 1,
    steps: [
      { action: { value: 1 }, game: { value: 1, lastMoves: [] }, passedColors: ["black"] },
      { action: { value: 2 }, game: { value: 2 } },
    ],
  },
};
type Event = { value: number; passedColors?: string[] };
const parseAction = (event: unknown) => event as Event;
const replay = (_initial: { value: number }, events: Event[]) =>
  events.map((event) => ({ value: event.value, lastMoves: [] }));

test("イベント本体と省略局面の印を作り、渡された再生関数で元のstepsを復元する", () => {
  const encoded = encodeSnapshotMatch(snapshot);
  expect(encoded.record.replay).toEqual({
    id: "replay",
    initial: { value: 0 },
    rulesVersion: 1,
    format: "events",
    version: 1,
    eventCount: 2,
    omittedLastMoves: [1],
  });
  expect(encoded.events).toEqual([{ value: 1, passedColors: ["black"] }, { value: 2 }]);
  const restored = rebuildSnapshotMatch<typeof snapshot, Event>(
    encoded.record,
    encoded.events,
    replay,
    parseAction,
  );
  expect(restored).toEqual(snapshot);
  expect(() => verifyFinalState(restored)).not.toThrow();
  expect(() => verifySnapshotReplay(restored, snapshot)).not.toThrow();
});

test("四人五目並べ以外ではlastMovesの省略の印を追加しない", () => {
  for (const game of ["reversi", "four-reversi", "gomoku"])
    expect(
      encodeSnapshotMatch({ ...snapshot, settings: { game } }).record.replay,
    ).not.toHaveProperty("omittedLastMoves");
});

test("イベントの欠落、不正な省略位置とイベントを拒否する", () => {
  const encoded = encodeSnapshotMatch(snapshot);
  expect(() =>
    rebuildSnapshotMatch<typeof snapshot, Event>(encoded.record, [], replay, parseAction),
  ).toThrow("Match event count mismatch");
  expect(() =>
    rebuildSnapshotMatch<typeof snapshot, Event>(
      { ...encoded.record, replay: { ...encoded.record.replay, omittedLastMoves: [2] } },
      encoded.events,
      replay,
      parseAction,
    ),
  ).toThrow("Invalid state field index");
  expect(() =>
    rebuildSnapshotMatch<typeof snapshot, Event>(
      encoded.record,
      [null, null],
      () => [{}, {}],
      parseAction,
    ),
  ).toThrow("Invalid match event");
});

test("最終局面と元stepsの相違をそれぞれ拒否し、空棋譜は初期局面と照合する", () => {
  expect(() => verifyFinalState({ ...snapshot, game: { value: 3 } })).toThrow(
    "Match replay final state mismatch",
  );
  expect(() =>
    verifyFinalState({
      game: { value: 0 },
      replay: { initial: { value: 0 }, steps: [] },
    }),
  ).not.toThrow();
  expect(() => verifySnapshotReplay(snapshot, { ...snapshot, game: {} })).toThrow(
    "Match event replay does not match saved steps",
  );
});
