import { expect, test } from "bun:test";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import type { GomokuRoom } from "@tetraboard/protocol";
import {
  advanceTurnClock,
  createGameProgress,
  type FinishedFor,
  type GameProgressSpec,
} from "../src";
import { gomokuCommand, gomokuProgressFixture } from "./gomokuProgressFixture";

type StoredTypes = Omit<GomokuTypes, "state" | "history"> & {
  state: GomokuTypes["state"] & { historyLoaded: boolean };
  history: () => number;
};

function storedDefinition(
  calls: string[],
  history: StoredTypes["history"],
): GameProgressSpec<"gomoku", StoredTypes>["definition"] {
  return {
    catalog: gomokuDefinition.catalog,
    cpu: { chooseAction: gomokuDefinition.cpu.chooseAction },
    rules: {
      ...gomokuDefinition.rules,
      createInitialState: (settings) => ({
        ...gomokuDefinition.rules.createInitialState(settings),
        historyLoaded: false,
      }),
      getTurn: (state) => {
        expect(state.historyLoaded).toBe(false);
        calls.push("read turn");
        return state.turn;
      },
      requiresTurn: () => false,
      endsTurn: () => {
        calls.push("ends turn");
        return false;
      },
      applyAction: (state, seat, action, lookup) => {
        calls.push("apply");
        expect(state.historyLoaded).toBe(true);
        expect(lookup).toBe(history);
        if (action.position.y === 1) return { ok: false, reason: { type: "not_your_turn" } };
        if (action.position.x === 0)
          return {
            ok: true,
            state,
            event: { type: "place", position: action.position, color: seat },
          };
        const next = gomokuDefinition.rules.applyAction(state, state.turn ?? seat, action);
        if (!next.ok) return next;
        if (state.status !== "playing" || next.state.status !== "playing")
          throw new Error("Expected playing state");
        return { ...next, state: { ...next.state, turn: state.turn, historyLoaded: true } };
      },
      eliminateSeat: (state, seat, reason, lookup) => {
        calls.push("eliminate");
        expect(lookup).toBe(history);
        const next = gomokuDefinition.rules.eliminateSeat(state, seat, reason);
        return { ...next, state: { ...next.state, historyLoaded: true } };
      },
    },
    replay: (initial, events) =>
      gomokuDefinition.replay(initial, events).map((state) => ({ ...state, historyLoaded: true })),
  };
}

function transitionStore(
  calls: string[],
  history: StoredTypes["history"],
): GameProgressSpec<"gomoku", StoredTypes>["store"] {
  return {
    start: () => {
      throw new Error("Unexpected start");
    },
    loadTransition: (playing, operation) => {
      calls.push("load " + operation);
      return { state: { ...playing.game, historyLoaded: true }, history };
    },
    recordTransition: (playing, { state, event }) => {
      calls.push("record " + event.type);
      const { historyLoaded, ...saved } = state;
      expect(historyLoaded).toBe(true);
      if (event.type === "eliminate") {
        expect(
          playing.players.find((player) => player.color === event.color)?.reconnectDeadline,
        ).toBeNull();
      }
      return {
        ...saved,
        board: saved.board.map((row) => [...row]),
        eliminatedColors: [...saved.eliminatedColors],
      };
    },
    finalize: () => {
      throw new Error("Unexpected finalize");
    },
  };
}

function storedProgressFixture() {
  const { room, time } = gomokuProgressFixture();
  const calls: string[] = [];
  const history = () => 1;
  const spec: GameProgressSpec<"gomoku", StoredTypes> = {
    gameId: "gomoku",
    definition: storedDefinition(calls, history),
    parseRoom: (input) => {
      calls.push("parse");
      return structuredClone(input) as GomokuRoom;
    },
    parseFinishedState: (_state, saved) => {
      if (!saved || saved.status !== "finished") throw new Error("Expected saved state");
      return saved;
    },
    stateFromRoom: (game) => ({ ...game, historyLoaded: false }),
    seat: (player) => player.color,
    inactiveSeats: (game) => game.eliminatedColors,
    waitingSeat: { color: null },
    unknownPlayerMessage: "Unknown Gomoku player",
    useActionRules: true,
    toAction: (command) => {
      calls.push("convert");
      return { type: "placeStone", position: command.action.position };
    },
    moveError: (_reason, action) => (action.position.y === 1 ? "invalid_request" : "invalid_move"),
    prepareLeaveResult: ({ state }) => ({ ok: true, state }),
    updatePlayersOnElimination: true,
    clearCpuJobsOnAccept: () => calls.push("delete jobs"),
    playingFields: (state) => {
      calls.push("playing fields");
      return { eliminations: state.eliminatedColors.map((color) => ({ color, reason: "left" })) };
    },
    waitingFields: { publicUpdatedAtMs: time.now + 1 },
    advanceClock: (...args) => {
      calls.push("advance clock");
      return advanceTurnClock(...args);
    },
    isClockExpired: (clock, at) => at >= clock.turnExpiresAt,
    membership: (hash) => ({ playerId: hash, role: "player" }),
    accountId: () => null,
    now: () => {
      calls.push("now");
      return time.now;
    },
    store: transitionStore(calls, history),
  };
  return { room, time, calls, progress: createGameProgress(spec) };
}

test("an action can be accepted off turn with a loaded history and projected room state", () => {
  const { room, progress, calls } = storedProgressFixture();

  const result = progress.play(room, "guest", gomokuCommand(room));

  expect(result).toMatchObject({
    kind: "playing",
    room: {
      game: { turn: "black" },
      positionRevision: room.positionRevision + 1,
      clock: room.clock,
    },
  });
  if (result.kind !== "playing") throw new Error("Expected playing room");
  expect(result.room.game).not.toHaveProperty("historyLoaded");
  expect(calls).toEqual([
    "convert",
    "read turn",
    "now",
    "load play",
    "apply",
    "now",
    "ends turn",
    "record place",
    "delete jobs",
    "playing fields",
    "advance clock",
    "parse",
  ]);
});

test("stale commands avoid history reads and an unchanged action avoids recording", () => {
  const { room, progress, calls } = storedProgressFixture();

  expect(
    progress.command(
      room,
      "guest",
      { type: "placeStone", position: { x: 0, y: 0 } },
      {
        roundId: room.roundId,
        positionRevision: room.positionRevision - 1,
      },
    ),
  ).toEqual({ kind: "rejected", error: "stale_position" });
  expect(calls.splice(0)).toEqual(["read turn", "now"]);

  expect(
    progress.command(room, "guest", { type: "placeStone", position: { x: 0, y: 0 } }, room),
  ).toEqual({ kind: "unchanged", gameId: "gomoku", room });
  expect(calls).toEqual(["read turn", "now", "load play", "apply"]);
});

test("elimination parses cleared deadlines before saving, even when the round finishes", () => {
  const { room, progress, time, calls } = storedProgressFixture();

  const result = progress.eliminate(room, "host", "left", time.now);

  expect(result).toMatchObject({
    kind: "finished",
    room: {
      players: [{ id: "host", reconnectDeadline: null }, { id: "guest" }],
      positionRevision: room.positionRevision,
    },
  });
  if (result.kind !== "finished") throw new Error("Expected finished round");
  expect(result.game).not.toHaveProperty("historyLoaded");
  expect(calls).toEqual([
    "load eliminate",
    "eliminate",
    "parse",
    "record eliminate",
    "delete jobs",
  ]);
});

test("an inactive player is skipped on timeout as well as on disconnect", () => {
  const { room, progress, time, calls } = storedProgressFixture();
  room.game.eliminatedColors = ["black"];

  expect(progress.eliminate(room, "host", "timeout", time.now)).toEqual({
    kind: "unchanged",
    gameId: "gomoku",
    room,
  });
  expect(calls).toEqual(["parse"]);
});

test("a prepared leave can finish using the saved public state", () => {
  const { room, progress, time, calls } = storedProgressFixture();
  const prepared = progress.prepareLeave(room, "guest");
  expect(calls).toEqual(["load eliminate", "eliminate", "record eliminate"]);

  const result = progress.leave(room, "guest", prepared, time.now, false);

  expect(result).toMatchObject({
    kind: "finished",
    game: { result: { winner: "black" }, eliminatedColors: ["white"] },
  });
  if (result.kind !== "finished") throw new Error("Expected finished round");
  expect(result.game).not.toHaveProperty("historyLoaded");
  expect(calls.slice(3)).toEqual(["delete jobs"]);
});

test("rematch waiting applies the game's reset fields", () => {
  const { room, progress, time } = storedProgressFixture();
  const eliminated = gomokuDefinition.rules.eliminateSeat(room.game, "black", "resigned").state;
  if (eliminated.status !== "finished") throw new Error("Expected finished round");
  const game: FinishedFor<"gomoku"> = {
    ...eliminated,
    board: eliminated.board.map((row) => [...row]),
    eliminatedColors: [...eliminated.eliminatedColors],
  };

  const waiting = progress.waiting(
    {
      room,
      at: time.now,
      lastRound: {
        settings: room.settings,
        game,
        players: [],
        replay: { id: room.roundId, initial: room.game, steps: [] },
      },
    },
    room.players,
  );
  expect(waiting).toMatchObject({
    status: "waiting",
    roundId: null,
    publicUpdatedAtMs: time.now + 1,
  });
});

test("rejecting an action can report an error based on its action type", () => {
  const { room, progress, calls } = storedProgressFixture();

  const result = progress.command(
    room,
    "guest",
    { type: "placeStone", position: { x: 0, y: 1 } },
    room,
  );

  expect(result).toEqual({ kind: "rejected", error: "invalid_request" });
  expect(calls).toEqual(["read turn", "now", "load play", "apply"]);
});
