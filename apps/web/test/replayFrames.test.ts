import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type FourReversiState,
  type Cell,
} from "@tetraboard/four-reversi";
import { roundReplaySchema, type LastRound } from "@tetraboard/protocol";
import { replayFrames } from "../src/features/room/replayFrames";

test("開始から最終手までの表記と盤面を復元し、自動パスは石を増やさず独立した項目にする", () => {
  const replay = roundReplaySchema.parse({
    id: crypto.randomUUID(),
    initial: createInitialState("singles"),
    steps: [],
  });
  let game: FourReversiState = replay.initial;
  while (game.status === "playing") {
    const position = getLegalMoves(game)[0];
    const action = { type: "place" as const, color: game.turn, position };
    const result = applyAction(game, { type: "placeStone", position });
    if (!result.ok) throw new Error("Invalid test move");
    game = result.state;
    replay.steps.push(
      roundReplaySchema.shape.steps.element.parse({
        action,
        game,
        passedColors: result.passedColors,
      }),
    );
  }
  const frames = replayFrames({ game, players: [], replay });
  expect(frames[0]).toEqual({ label: "開始局面", game: replay.initial });
  expect(frames[1].label).toBe("1: 黒C4");
  expect(frames.at(-1)?.game).toEqual(game);
  const passFrames = frames.filter((frame) => frame.label.endsWith("パス"));
  expect(passFrames.length).toBeGreaterThan(0);
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.label.endsWith("パス")) {
      expect(frame.game.board).toEqual(frames[index - 1].game.board);
      expect(frame.game.moveNumber).toBe(frames[index - 1].game.moveNumber);
      expect(frame.game.lastMove).toEqual(frames[index - 1].game.lastMove);
      expect(getLegalMoves(frames[index - 1].game)).toHaveLength(0);
    }
  }
});

test("脱落原因を区別し、着手がなくても初期局面から終局まで戻れる", () => {
  const reasons = ["resigned", "left", "timeout", "disconnected"] as const;
  const labels = ["投了", "退室", "時間切れ", "通信切れ"];
  reasons.forEach((reason, index) => {
    const initial = createInitialState("doubles");
    const result = eliminateColor(initial, "black");
    if (!result.ok || result.state.status !== "finished") throw new Error("Game did not finish");
    const replay = roundReplaySchema.parse({
      id: crypto.randomUUID(),
      initial,
      steps: [
        {
          action: { type: "eliminate", color: "black", reason },
          game: result.state,
          passedColors: [],
        },
      ],
    });
    const frames = replayFrames({ game: result.state, players: [], replay });
    expect(frames.map((frame) => frame.label)).toEqual(["開始局面", `黒 ${labels[index]}`]);
    expect(frames[1].game.eliminatedColors).toEqual(["black"]);
    expect(frames[1].game.moveNumber).toBe(0);
    expect(frames[1].game.lastMove).toBeNull();
  });
});

test("導入前の対局は記録を捏造せず最終局面だけを表示する", () => {
  const result = eliminateColor(createInitialState("doubles"), "red");
  if (!result.ok || result.state.status !== "finished") throw new Error("Game did not finish");
  const lastRound: LastRound = { game: result.state, players: [], replay: null };
  expect(replayFrames(lastRound)).toEqual([{ label: "最終局面（棋譜なし）", game: result.state }]);
});

test("全員の自動パスで終局する場合、最後のパスまでは手番を順に表示する", () => {
  const board = Array.from({ length: 8 }, () => Array<Cell>(8).fill("black"));
  board[0][1] = "white";
  board[0][2] = null;
  board[2][1] = "red";
  board[4][1] = "blue";
  board[3][1] = "white";
  board[7][7] = null;
  const initial = { ...createInitialState("singles"), board };
  const result = applyAction(initial, { type: "placeStone", position: { x: 2, y: 0 } });
  if (!result.ok || result.state.status !== "finished") throw new Error("Game did not finish");
  const replay = roundReplaySchema.parse({
    id: crypto.randomUUID(),
    initial,
    steps: [
      {
        action: { type: "place", color: "black", position: { x: 2, y: 0 } },
        game: result.state,
        passedColors: result.passedColors,
      },
    ],
  });
  const frames = replayFrames({ game: result.state, players: [], replay });
  expect(frames.map((frame) => [frame.label, frame.game.turn])).toEqual([
    ["開始局面", "black"],
    ["1: 黒C1", "white"],
    ["白 パス", "red"],
    ["赤 パス", "blue"],
    ["青 パス", "black"],
    ["黒 パス", null],
  ]);
  expect(frames.at(-1)?.game.result?.reason).toBe("all_passed");
});
