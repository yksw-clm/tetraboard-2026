import { expect, test } from "bun:test";
import { gomokuDefinition } from "@tetraboard/gomoku/definition";
import type { WaitingFor } from "../src";
import { gomokuCommand, gomokuProgressFixture } from "./gomokuProgressFixture";

test("a game with its own CPU jobs delegates start without touching those jobs", () => {
  const calls: string[] = [];
  const { room, progress } = gomokuProgressFixture({
    store: {
      start: () => {
        calls.push("start");
        return { room, roundId: room.roundId, at: room.clock.turnStartedAt };
      },
      recordTransition: () => {
        throw new Error("Unexpected transition");
      },
      finalize: () => {
        throw new Error("Unexpected finalize");
      },
    },
  });
  const waiting: WaitingFor<"gomoku"> = {
    ...room,
    status: "waiting",
    clock: null,
    game: null,
    roundId: null,
    positionRevision: 0,
    players: room.players.map((player) => ({ ...player, color: null })),
  };

  const started = progress.start(waiting);

  expect(started.room).toBe(room);
  expect(calls).toEqual(["start"]);
});

test("accept can clear game-specific jobs after recording a move", () => {
  const { room, progress, saved } = gomokuProgressFixture({
    clearCpuJobsOnAccept: () => {
      saved.calls.push("deleteFirstJob", "deleteSecondJob");
    },
  });

  const result = progress.play(room, "host-token", gomokuCommand(room));

  expect(result.kind).toBe("playing");
  expect(saved.calls).toEqual(["recordTransition", "deleteFirstJob", "deleteSecondJob"]);
});

test("finishing can increment the revision before the room is handed to finalization", () => {
  const { room, progress } = gomokuProgressFixture({ incrementRevisionOnFinish: true });

  const result = progress.resign(room, "host-token");

  expect(result).toMatchObject({
    kind: "finished",
    room: {
      positionRevision: room.positionRevision + 1,
      game: room.game,
      clock: room.clock,
      lastActivityAtMs: room.lastActivityAtMs,
      eliminations: [{ color: "black", reason: "resigned" }],
    },
  });
  expect(room.positionRevision).toBe(3);
});

test("preparing a leave can return game-specific event details", () => {
  const { room, progress, saved } = gomokuProgressFixture({
    prepareLeaveResult: ({ state, event }) => ({ ok: true, state, departure: event.type }),
  });

  const prepared = progress.prepareLeave(room, "host");

  const expected = {
    ok: true,
    state: saved.transitions[0]?.state,
    departure: "eliminate",
  } as const;
  expect(prepared).toEqual(expected);
  expect(saved.calls).toEqual(["recordTransition"]);
});

test("an inactive host can leave without changing the game or its revision", () => {
  const { room, progress, saved, time } = gomokuProgressFixture({
    preservePositionOnInactiveLeave: true,
  });
  room.game.eliminatedColors = ["white"];
  room.players[1].reconnectDeadline = time.now + 10_000;

  const result = progress.leave(room, "guest", null, time.now, true);

  expect(result).toEqual({
    kind: "playing",
    gameId: "gomoku",
    room: {
      ...room,
      publicUpdatedAtMs: time.now,
      lastActivityAtMs: time.now,
      players: [room.players[0], { ...room.players[1], reconnectDeadline: null }],
    },
  });
  expect(saved.calls).toEqual(["deleteCpuJob"]);
});

test("accepting a transition can advance the clock at a separate time", () => {
  const { room, progress, time } = gomokuProgressFixture();
  const clockAt = time.now - 100;
  const transition = gomokuDefinition.rules.applyAction(room.game, "black", {
    type: "placeStone",
    position: gomokuCommand(room).action.position,
  });
  if (!transition.ok) throw new Error("Expected a legal move");

  const result = progress.accept(room, transition.state, time.now, true, { clockAt });

  expect(result).toMatchObject({
    kind: "playing",
    room: {
      positionRevision: room.positionRevision + 1,
      lastActivityAtMs: time.now,
      clock: {
        remainingMainMs: { black: 59_600, white: 60_000 },
        turnStartedAt: clockAt,
        turnExpiresAt: clockAt + 60_000,
      },
    },
  });
});
