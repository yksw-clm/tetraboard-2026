import { expect, test } from "bun:test";
import { reversiActionComplete } from "../src/features/room/fourReversiSessionBehavior";
import {
  shogiActionComplete,
  type PendingShogiAction,
} from "../src/features/room/fourShogiSessionBehavior";
import { playingRoom, waitingRoom } from "./fixtures/rooms";
import { replayMatch } from "./fixtures/matchReplayFixtures";
import {
  playingShogiRoom,
  waitingShogiRoom,
  finishedShogiRound,
} from "./fixtures/fourShogiFixtures";

test("リバーシは同局面・他人の脱落ではpendingを維持し、着手進行・本人脱落・終局で解除", () => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("fixture");
  const move = { type: "move", moveNumber: room.game.moveNumber } as const;
  expect(reversiActionComplete(room, move)).toBe(false);
  expect(
    reversiActionComplete(
      { ...room, game: { ...room.game, moveNumber: room.game.moveNumber + 1 } },
      move,
    ),
  ).toBe(true);
  const resign = { type: "resign", participant: "black" } as const;
  expect(
    reversiActionComplete({ ...room, game: { ...room.game, eliminatedColors: ["white"] } }, resign),
  ).toBe(false);
  expect(
    reversiActionComplete({ ...room, game: { ...room.game, eliminatedColors: ["black"] } }, resign),
  ).toBe(true);
  expect(reversiActionComplete(waitingRoom(), move)).toBe(false);
  const saved = replayMatch(),
    waiting = waitingRoom();
  waiting.lastRound = { game: saved.game, players: saved.participants, replay: saved.replay };
  expect(reversiActionComplete(waiting, move)).toBe(true);
  expect(reversiActionComplete(waiting, resign)).toBe(true);
});

test("将棋の着手・提案はrevisionと局IDを区別し、再戦待機ではすべて解除", () => {
  const room = playingShogiRoom();
  const move: PendingShogiAction = {
    type: "move",
    roundId: room.roundId,
    positionRevision: 0,
    participant: "south",
    action: room.legalActions[0]!,
    startedAtMs: 0,
  };
  const draw: PendingShogiAction = {
    type: "draw",
    participant: "south",
    proposed: true,
    roundId: room.roundId,
    positionRevision: 0,
  };
  for (const pending of [move, draw]) {
    expect(shogiActionComplete(room, pending)).toBe(false);
    expect(shogiActionComplete({ ...room, positionRevision: 1 }, pending)).toBe(true);
    expect(shogiActionComplete({ ...room, roundId: "new-round" }, pending)).toBe(true);
    expect(shogiActionComplete(finishedShogiRound().room, pending)).toBe(true);
  }
  const proposed = { ...room, game: { ...room.game, drawProposals: ["south" as const] } };
  expect(shogiActionComplete(proposed, draw)).toBe(true);
  expect(shogiActionComplete(proposed, { ...draw, proposed: false })).toBe(false);
  expect(shogiActionComplete(room, { ...draw, proposed: false })).toBe(true);
  expect(shogiActionComplete(waitingShogiRoom(), move)).toBe(false);
  expect(
    shogiActionComplete(finishedShogiRound().room, { type: "resign", participant: "south" }),
  ).toBe(true);
});
