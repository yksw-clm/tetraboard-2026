import { expect, test } from "bun:test";
import { eventReplayPositions, snapshotReplayPositions } from "../src/replayPositions";

test("着手の直後に自動パスを色ごとの局面として数える", () => {
  expect(
    snapshotReplayPositions({
      steps: [
        { action: "place", passedColors: ["black", "white"] },
        { action: "place", passedColors: [] },
        { action: "eliminate", passedColors: ["red"] },
      ],
    }),
  ).toEqual([
    { kind: "initial" },
    { kind: "step", stepIndex: 0 },
    { kind: "pass", stepIndex: 0, passIndex: 0 },
    { kind: "pass", stepIndex: 0, passIndex: 1 },
    { kind: "step", stepIndex: 1 },
    { kind: "step", stepIndex: 2 },
    { kind: "pass", stepIndex: 2, passIndex: 0 },
  ]);
});

test("パスのない棋譜は開始と各 step、棋譜のない対局は最終局面だけを返す", () => {
  expect(snapshotReplayPositions({ steps: [{ action: "place" }] })).toEqual([
    { kind: "initial" },
    { kind: "step", stepIndex: 0 },
  ]);
  expect(snapshotReplayPositions({ steps: [] })).toEqual([{ kind: "initial" }]);
  expect(snapshotReplayPositions(undefined)).toEqual([{ kind: "final" }]);
});

test("将棋系は開始局面と保存済みイベントごとに 1 局面を返す", () => {
  expect(eventReplayPositions(0)).toEqual([{ kind: "initial" }]);
  expect(eventReplayPositions(3)).toEqual([
    { kind: "initial" },
    { kind: "event", eventIndex: 0 },
    { kind: "event", eventIndex: 1 },
    { kind: "event", eventIndex: 2 },
  ]);
});
