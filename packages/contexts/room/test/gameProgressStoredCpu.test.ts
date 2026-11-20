import { expect, test } from "bun:test";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import { cpuMoveDelayMs } from "../src";
import type { ProgressCpuJob } from "../src/use-cases/gameProgressSpec";
import { gomokuProgressFixture, useBlackCpu } from "./gomokuProgressFixture";

const action = { type: "placeStone", position: { x: 7, y: 7 } } as const;

function storedCpuFixture() {
  const lookup = () => 1;
  const hasLoadedHistory = (state: GomokuTypes["state"], history: unknown) =>
    state.board[0][0] === "white" && history === lookup;
  const jobs: { pending?: ProgressCpuJob<GomokuTypes> } = {};
  const { room, progress, time } = gomokuProgressFixture({
    definition: {
      ...gomokuDefinition,
      cpu: {
        chooseAction: (state, _seat, _level, _random, history) =>
          hasLoadedHistory(state, history) ? action : null,
      },
      rules: {
        ...gomokuDefinition.rules,
        applyAction: (state, seat, move, history) =>
          hasLoadedHistory(state, history)
            ? gomokuDefinition.rules.applyAction(state, seat, move)
            : { ok: false, reason: { type: "not_your_turn" } },
      },
    },
    store: {
      start: () => {
        throw new Error("Unexpected start");
      },
      recordTransition: () => {},
      finalize: () => {
        throw new Error("Unexpected finalize");
      },
      loadTransition: ({ game }) => {
        const board = game.board.map((row) => [...row]);
        board[0][0] = "white";
        return { state: { ...game, board }, history: lookup };
      },
      cpuJobs: {
        read: () => jobs.pending,
        write: (job) => {
          jobs.pending = job;
        },
        delete: () => {
          delete jobs.pending;
        },
      },
    },
  });
  useBlackCpu(room);
  time.now = room.clock.turnStartedAt + cpuMoveDelayMs;
  return { room, progress, at: time.now, jobs };
}

test("CPU uses the loaded state and history to choose and save a move", () => {
  const { room, progress, at, jobs } = storedCpuFixture();

  const result = progress.cpu(room, at);

  expect(result).toEqual({ kind: "unchanged", gameId: "gomoku", room });
  expect(jobs.pending).toEqual({
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    seat: "black",
    action,
    applyAt: at + 1,
  });
});

test("CPU uses the loaded state and history to apply a saved move", () => {
  const { room, progress, at, jobs } = storedCpuFixture();
  jobs.pending = {
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    seat: "black",
    action,
    applyAt: at,
  };

  const result = progress.cpu(room, at);

  if (result.kind !== "playing") throw new Error("Expected playing room");
  expect(result.room.game.board[0][0]).toBe("white");
  expect(result.room.game.board[7][7]).toBe("black");
  expect(jobs.pending).toBeUndefined();
});
