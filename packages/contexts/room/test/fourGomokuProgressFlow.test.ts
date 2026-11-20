import { expect, test } from "bun:test";
import type { WaitingFor } from "../src";
import {
  afterBlackCompletes,
  fourGomokuCommand,
  fourGomokuProgressFixture,
} from "./fourGomokuProgressFixture";

test("start clears the saved CPU move before forwarding tournament information", () => {
  const { room, progress, saved, at } = fourGomokuProgressFixture();
  const waiting: WaitingFor<"four-gomoku"> = {
    ...room,
    status: "waiting",
    game: null,
    clock: null,
    roundId: null,
    positionRevision: 0,
    players: room.players.map((player) => ({ ...player, color: null })),
    eliminations: [],
  };
  const tournament = { matchId: "00000000-0000-4000-8000-000000000002" };

  const result = progress.start(waiting, tournament);

  expect(result).toEqual({
    room: { ...room, roundId: tournament.matchId },
    roundId: tournament.matchId,
    at,
  });
  expect(saved.start).toEqual({ room: waiting, args: [tournament] });
  expect(saved.calls).toEqual(["deleteCpuJob", "start"]);
});

test.each(["play", "resign"] as const)("%s rejects a completed seat", (operation) => {
  const { room, progress, saved } = fourGomokuProgressFixture();
  afterBlackCompletes(room);

  const result =
    operation === "play"
      ? progress.play(room, "black", fourGomokuCommand(room))
      : progress.resign(room, "black");

  expect(result).toEqual({ kind: "rejected", error: "already_eliminated" });
  expect(saved.calls).toEqual([]);
});

test.each([
  { turn: "black", next: "white" },
  { turn: "white", next: "red" },
  { turn: "red", next: "blue" },
  { turn: "blue", next: "black" },
] as const)("a move advances the turn and clock from $turn to $next", ({ turn, next }) => {
  const { room, progress, saved, at } = fourGomokuProgressFixture();
  room.game = { ...room.game, turn };

  const result = progress.play(room, turn, fourGomokuCommand(room));

  expect(result.kind).toBe("playing");
  if (result.kind !== "playing") throw new Error("Expected playing progress");
  expect(result.room.game.turn).toBe(next);
  expect(result.room.clock).toEqual({
    remainingMainMs: { ...room.clock.remainingMainMs, [turn]: 59_500 },
    turnStartedAt: at,
    turnExpiresAt: at + 60_000,
  });
  expect(saved.transitions[0]?.event).toEqual({
    type: "place",
    color: turn,
    position: { x: 7, y: 7 },
  });
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test("the next turn skips a completed seat", () => {
  const { room, progress } = fourGomokuProgressFixture();
  afterBlackCompletes(room);
  room.game = { ...room.game, turn: "blue" };

  const result = progress.play(room, "blue", fourGomokuCommand(room));

  expect(result).toMatchObject({ kind: "playing", room: { game: { turn: "white" } } });
});

test("a completed seat leaves without recording an elimination or advancing the clock", () => {
  const { room, progress, saved, at } = fourGomokuProgressFixture();
  afterBlackCompletes(room);
  const { id } = room.players[0];
  const prepared = progress.prepareLeave(room, id);
  expect(prepared).toBeNull();

  const result = progress.leave(room, id, prepared, at, true);

  expect(result).toEqual({
    kind: "playing",
    gameId: "four-gomoku",
    room: {
      ...room,
      positionRevision: room.positionRevision + 1,
      lastActivityAtMs: at,
      publicUpdatedAtMs: at,
      players: [{ ...room.players[0], reconnectDeadline: null }, ...room.players.slice(1)],
    },
  });
  expect(saved.calls).toEqual(["deleteCpuJob"]);
});

test.each(["completedColors", "eliminatedColors"] as const)(
  "disconnecting a seat in %s only clears its reconnect deadline",
  (field) => {
    const { room, progress, saved, at } = fourGomokuProgressFixture();
    room.game = { ...room.game, turn: "white", [field]: ["black"] };

    const result = progress.eliminate(room, room.players[0].id, "disconnected", at);

    expect(result).toEqual({
      kind: "unchanged",
      gameId: "four-gomoku",
      room: {
        ...room,
        players: [{ ...room.players[0], reconnectDeadline: null }, ...room.players.slice(1)],
      },
    });
    expect(saved.calls).toEqual([]);
  },
);

test("disconnecting an active seat out of turn records the elimination and preserves the clock", () => {
  const { room, progress, saved } = fourGomokuProgressFixture();
  const player = room.players[2];
  if (player.reconnectDeadline === null) throw new Error("Expected reconnect deadline");

  const result = progress.eliminate(room, player.id, "disconnected", player.reconnectDeadline);

  expect(result).toMatchObject({
    kind: "playing",
    room: {
      clock: room.clock,
      game: { turn: "black", eliminatedColors: ["red"] },
      eliminations: [{ color: "red", reason: "disconnected" }],
    },
  });
  if (result.kind !== "playing") throw new Error("Expected playing progress");
  expect(result.room.players[2].reconnectDeadline).toBeNull();
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test("timing out the current seat moves the clock to the next active color", () => {
  const { room, progress, saved } = fourGomokuProgressFixture();
  afterBlackCompletes(room);
  room.game = { ...room.game, turn: "blue" };
  const deadline = room.clock.turnExpiresAt;

  const result = progress.eliminate(room, room.players[3].id, "timeout", deadline);

  expect(result).toMatchObject({
    kind: "playing",
    room: {
      clock: {
        remainingMainMs: { ...room.clock.remainingMainMs, blue: 0 },
        turnStartedAt: deadline,
        turnExpiresAt: deadline + 60_000,
      },
      game: { turn: "white", completedColors: ["black"], eliminatedColors: ["blue"] },
      eliminations: [{ color: "blue", reason: "timeout" }],
    },
  });
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test("a doubles leave that ends the game returns the original room for finalization", () => {
  const { room, progress, saved, at } = fourGomokuProgressFixture("doubles");
  const { id } = room.players[0];
  const prepared = progress.prepareLeave(room, id);
  expect(saved.calls).toEqual(["recordTransition"]);

  const result = progress.leave(room, id, prepared, at, true);

  expect(result).toMatchObject({
    kind: "finished",
    at,
    game: { result: { mode: "doubles", reason: "team_eliminated", winner: "white-blue" } },
  });
  if (result.kind !== "finished") throw new Error("Expected finished progress");
  expect(result.room).toBe(room);
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});
