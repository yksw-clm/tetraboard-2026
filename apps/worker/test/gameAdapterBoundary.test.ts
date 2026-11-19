import { afterEach, beforeEach, expect, test } from "vitest";
import { gameIds, type GameId, type RoomSocketClientMessage } from "@tetraboard/protocol";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import type { ActionCommand } from "../src/rooms/gameAdapters/types";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});

const actions: ActionCommand["action"][] = [
  { type: "placeStone", position: { x: 0, y: 0 } },
  { type: "placeGomokuStone", position: { x: 0, y: 0 } },
  { type: "placeFourGomokuStone", position: { x: 0, y: 0 } },
  { type: "movePiece", from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, promote: false },
];
const supported: Record<GameId, ActionCommand["action"]["type"]> = {
  "four-reversi": "placeStone",
  reversi: "placeStone",
  "four-shogi": "movePiece",
  shogi: "movePiece",
  "four-gomoku": "placeFourGomokuStone",
  gomoku: "placeGomokuStone",
};

test.each(gameIds)("%s: 未対応の操作の拒否と開始前のエラーを維持する", async (game) => {
  const entry = await fixtures.create({
    game,
    name: "本人",
    quickPlay: false,
    ...(game.startsWith("four-") ? { mode: "singles" } : {}),
  });
  const host = await fixtures.connect(entry);
  const before = (await fixtures.snapshot(entry.room.id)).room;
  const position = { roundId: crypto.randomUUID(), positionRevision: 0 };
  for (const action of actions) {
    host.send({
      type: "room.game.action",
      action,
      ...position,
    });
    expect((await host.waitFor("room.error")).error).toBe(
      action.type === supported[game] ? "game_not_started" : "invalid_move",
    );
  }
  const commands: { command: RoomSocketClientMessage; error: string }[] = [
    {
      command: { type: "room.game.draw.set", proposed: true, ...position },
      error: game === "shogi" || game === "four-shogi" ? "game_not_started" : "invalid_request",
    },
    {
      command: { type: "room.game.declare", ...position },
      error: game === "shogi" ? "game_not_started" : "invalid_request",
    },
  ];
  if (game !== "gomoku")
    commands.push({
      command: { type: "room.gomoku-forbidden.set", enabled: false },
      error: "invalid_request",
    });
  if (game !== "four-shogi")
    commands.push({
      command: { type: "room.three-player-attack.set", prohibited: false },
      error: "invalid_request",
    });
  if (!game.startsWith("four-"))
    commands.push({
      command: { type: "room.mode.set", mode: "singles" },
      error: "forbidden",
    });
  if (game === "reversi" || game === "four-reversi")
    commands.push({
      command: {
        type: "room.game.action",
        action: actions[0],
      },
      error: "invalid_request",
    });
  for (const { command, error } of commands) {
    host.send(command);
    expect((await host.waitFor("room.error")).error).toBe(error);
  }
  expect((await fixtures.snapshot(entry.room.id)).room).toEqual(before);
});
