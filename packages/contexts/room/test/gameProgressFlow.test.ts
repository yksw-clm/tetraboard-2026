import { expect, test } from "bun:test";
import { cpuMoveDelayMs } from "../src";
import { gomokuCommand, gomokuProgressFixture, useBlackCpu } from "./gomokuProgressFixture";

test("a Gomoku move records the event, advances the clock and increments the revision", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();
  const command = gomokuCommand(room);

  const result = progress.play(room, "host-token", command);

  expect(result.kind).toBe("playing");
  if (result.kind !== "playing") throw new Error("Expected playing progress");
  expect(result.room.game.board[7][7]).toBe("black");
  expect(result.room.game.turn).toBe("white");
  expect(result.room.positionRevision).toBe(room.positionRevision + 1);
  expect(result.room.lastActivityAtMs).toBe(time.now);
  expect(result.room.clock).toEqual({
    remainingMainMs: { black: 59_500, white: 60_000 },
    turnStartedAt: time.now,
    turnExpiresAt: time.now + 60_000,
  });
  expect(saved.transitions).toEqual([
    { state: result.room.game, event: { type: "place", color: "black", position: { x: 7, y: 7 } } },
  ]);
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test.each(["roundId", "positionRevision"] as const)("play rejects a stale %s", (field) => {
  const { room, progress, saved } = gomokuProgressFixture();
  const command = gomokuCommand(room);
  const stale =
    field === "roundId"
      ? { ...command, roundId: "old-round" }
      : { ...command, positionRevision: 2 };

  expect(progress.play(room, "host-token", stale)).toEqual({
    kind: "rejected",
    error: "stale_position",
  });
  expect(saved.calls).toEqual([]);
});

test("play rejects a player who does not have the turn", () => {
  const { room, progress, saved } = gomokuProgressFixture();

  expect(progress.play(room, "guest-token", gomokuCommand(room))).toEqual({
    kind: "rejected",
    error: "not_your_turn",
  });
  expect(saved.calls).toEqual([]);
});

test("resigning records the loss and returns the original room for finalization", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();

  const result = progress.resign(room, "host-token");

  expect(result).toMatchObject({
    kind: "finished",
    gameId: "gomoku",
    at: time.now,
    game: { status: "finished", result: { winner: "white", reason: "last_player" } },
  });
  if (result.kind !== "finished") throw new Error("Expected finished progress");
  expect(result.room).toBe(room);
  expect(room.positionRevision).toBe(3);
  expect(room.lastActivityAtMs).toBeLessThan(time.now);
  expect(room.eliminations).toEqual([{ color: "black", reason: "resigned" }]);
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test("leaving records the elimination during preparation and immediately returns a finished game", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();
  const { reconnectDeadline } = room.players[0];

  const prepared = progress.prepareLeave(room, "host");
  expect(saved.transitions[0]?.event).toEqual({
    type: "eliminate",
    color: "black",
    reason: "left",
  });
  expect(saved.calls).toEqual(["recordTransition"]);
  const result = progress.leave(room, "host", prepared, time.now, true);

  expect(result).toMatchObject({
    kind: "finished",
    at: time.now,
    game: { result: { winner: "white" } },
  });
  if (result.kind !== "finished") throw new Error("Expected finished progress");
  expect(result.room).toBe(room);
  expect(result.room.players[0].reconnectDeadline).toBe(reconnectDeadline);
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test.each(["disconnected", "timeout"] as const)("%s eliminates the selected player", (reason) => {
  const { room, progress, saved } = gomokuProgressFixture();
  const player = reason === "disconnected" ? room.players[1] : room.players[0];
  const at =
    reason === "disconnected" ? room.clock.turnStartedAt + 30_000 : room.clock.turnExpiresAt;

  const result = progress.eliminate(room, player.id, reason, at);

  expect(result).toMatchObject({
    kind: "finished",
    at,
    game: { result: { winner: player.color === "black" ? "white" : "black" } },
  });
  expect(room.eliminations).toEqual([{ color: player.color, reason }]);
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test("disconnecting an already eliminated seat only clears its reconnect deadline", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();
  room.game.eliminatedColors = ["black"];

  expect(progress.eliminate(room, "host", "disconnected", time.now)).toEqual({
    kind: "unchanged",
    gameId: "gomoku",
    room: { ...room, players: [{ ...room.players[0], reconnectDeadline: null }, room.players[1]] },
  });
  expect(saved.calls).toEqual([]);
});

test("play rejects a move at the clock deadline", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();
  time.now = room.clock.turnExpiresAt;

  expect(progress.play(room, "host-token", gomokuCommand(room))).toEqual({
    kind: "rejected",
    error: "time_expired",
  });
  expect(saved.calls).toEqual([]);
});

test("CPU saves a move only after the minimum delay and applies it on a subsequent Alarm", () => {
  const { room, progress, saved, time } = gomokuProgressFixture();
  useBlackCpu(room);
  time.now = room.clock.turnStartedAt + cpuMoveDelayMs;
  const unchanged = { kind: "unchanged", gameId: "gomoku", room } as const;

  expect(progress.cpu(room, time.now - 1)).toEqual(unchanged);
  expect(saved.cpuJob).toBeUndefined();
  expect(progress.cpu(room, time.now)).toEqual(unchanged);
  const job = saved.cpuJob;
  expect(job).toBeDefined();
  if (!job) throw new Error("Expected saved CPU job");
  expect(job).toMatchObject({
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    seat: "black",
    applyAt: time.now + 1,
  });
  expect(progress.cpu(room, time.now)).toEqual(unchanged);
  expect(saved.calls).toEqual([]);

  const result = progress.cpu(room, job.applyAt);

  expect(result.kind).toBe("playing");
  if (result.kind !== "playing") throw new Error("Expected playing progress");
  const { x, y } = job.action.position;
  expect(result.room.game.board[y][x]).toBe("black");
  expect(result.room.positionRevision).toBe(room.positionRevision + 1);
  expect(result.room.lastActivityAtMs).toBe(job.applyAt);
  expect(saved.cpuJob).toBeUndefined();
  expect(saved.calls).toEqual(["recordTransition", "deleteCpuJob"]);
});

test.each([{ roundId: "old-round" }, { positionRevision: 2 }, { seat: "white" as const }])(
  "CPU drops a saved move for a different position (%j)",
  (mismatch) => {
    const { room, progress, saved } = gomokuProgressFixture();
    useBlackCpu(room);
    const applyAt = room.clock.turnStartedAt + cpuMoveDelayMs;
    saved.cpuJob = {
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      seat: "black",
      action: { type: "placeStone", position: { x: 7, y: 7 } },
      applyAt,
      ...mismatch,
    };

    expect(progress.cpu(room, applyAt)).toEqual({ kind: "unchanged", gameId: "gomoku", room });
    expect(saved.cpuJob).toBeUndefined();
    expect(saved.calls).toEqual(["deleteCpuJob"]);
  },
);

test("CPU does not apply a ready move once the clock expires", () => {
  const { room, progress, saved } = gomokuProgressFixture();
  useBlackCpu(room);
  const job = {
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    seat: "black" as const,
    action: { type: "placeStone" as const, position: { x: 7, y: 7 } },
    applyAt: room.clock.turnStartedAt + cpuMoveDelayMs,
  };
  saved.cpuJob = job;

  expect(progress.cpu(room, room.clock.turnExpiresAt)).toEqual({
    kind: "unchanged",
    gameId: "gomoku",
    room,
  });
  expect(saved.cpuJob).toBe(job);
  expect(saved.calls).toEqual([]);
});
