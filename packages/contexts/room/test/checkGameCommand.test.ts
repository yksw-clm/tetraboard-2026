import { expect, test } from "bun:test";
import {
  checkGameCommand,
  type GameCommandInput,
  type GameCommandRejection,
} from "@tetraboard/context-room";

type Input = GameCommandInput<"black" | "white">;
const allowed: Input = {
  operation: "play",
  status: "playing",
  hasLastRound: false,
  seat: "black",
  eliminatedSeats: [],
  turn: "black",
  positionMatches: true,
  clockExpired: false,
};

test.each<[GameCommandRejection, Partial<Input>]>([
  ["game_not_started", { status: "waiting" }],
  ["game_finished", { status: "waiting", hasLastRound: true }],
  ["unauthorized", { seat: null }],
  ["stale_position", { positionMatches: false }],
  ["time_expired", { clockExpired: true }],
  ["already_eliminated", { eliminatedSeats: ["black"] }],
  ["not_your_turn", { turn: "white" }],
])("%s を返す", (code, change) => {
  expect(checkGameCommand({ ...allowed, ...change })).toBe(code);
});

test.each<[GameCommandRejection, Partial<Input>]>([
  [
    "game_not_started",
    {
      status: "waiting",
      seat: null,
      positionMatches: false,
      clockExpired: true,
      eliminatedSeats: ["black"],
      turn: "white",
    },
  ],
  ["game_finished", { status: "waiting", hasLastRound: true, seat: null, clockExpired: true }],
  ["unauthorized", { seat: null, positionMatches: false, clockExpired: true }],
  ["stale_position", { positionMatches: false, clockExpired: true, eliminatedSeats: ["black"] }],
  ["time_expired", { clockExpired: true, eliminatedSeats: ["black"], turn: "white" }],
  ["already_eliminated", { eliminatedSeats: ["black"], turn: "white" }],
])("条件が重なっても %s を先に返す", (code, change) => {
  expect(checkGameCommand({ ...allowed, ...change })).toBe(code);
});

test("着手・投了とも全条件を満たせば通す", () => {
  expect(checkGameCommand(allowed)).toBeNull();
  expect(checkGameCommand({ ...allowed, operation: "resign" })).toBeNull();
  expect(checkGameCommand({ ...allowed, eliminatedSeats: ["white"] })).toBeNull();
});

test("投了では古い局面の段だけを飛ばす", () => {
  const resign: Input = { ...allowed, operation: "resign", positionMatches: false };
  expect(checkGameCommand(resign)).toBeNull();
  expect(checkGameCommand({ ...resign, clockExpired: true })).toBe("time_expired");
  expect(checkGameCommand({ ...resign, seat: null, clockExpired: true })).toBe("unauthorized");
  expect(checkGameCommand({ ...resign, eliminatedSeats: ["black"], turn: "white" })).toBe(
    "already_eliminated",
  );
  expect(checkGameCommand({ ...resign, turn: null })).toBe("not_your_turn");
});
