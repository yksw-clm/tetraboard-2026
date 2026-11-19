import {
  createRoomContract,
  roomSchema,
  isFourShogiRoom,
  isFourReversiRoom,
  isFourGomokuRoom,
  type GameId,
  type Room,
} from "@tetraboard/protocol";
import { createInitialState as createShogiState } from "@tetraboard/shogi";
import { createInitialState as createFourShogiState } from "@tetraboard/four-shogi";
import { gameDefinitions } from "../src/rooms/gameDefinitions";
import { waitingRoomFactories } from "../src/adapters/room/waitingRoomFactories";
import type { RoomStateMigrationDependencies } from "../src/rooms/roomStateVersion";

import {
  migrateLegacyFourShogiRoom,
  migrateLegacyFourReversiRoom,
  migrateLegacyFourGomokuRoom,
} from "../src/rooms/legacyRoomMigrations";

export function migrationDependencies(readReplay: () => unknown): RoomStateMigrationDependencies {
  return {
    readReplay,
    migrateLegacy: (room, saved, read) => {
      if (isFourShogiRoom(room)) migrateLegacyFourShogiRoom(room, saved);
      else if (isFourReversiRoom(room)) migrateLegacyFourReversiRoom(room, saved, read);
      else if (isFourGomokuRoom(room)) migrateLegacyFourGomokuRoom(room, read);
    },
  };
}

export function roomFixture(game: GameId, status: "waiting" | "playing" = "playing"): Room {
  const request = createRoomContract.request.parse({
    game,
    name: "旧ルーム",
    quickPlay: true,
    ...(game.startsWith("four-") ? { mode: "singles" } : {}),
  });
  const base = waitingRoomFactories[game]({ code: "12345", name: "旧ルーム", request });
  if (status === "waiting") return roomSchema.parse(base);
  const seats = gameDefinitions[game].catalog.seats;
  const players = base.players.map((player, index) => ({
    ...player,
    [game === "four-shogi" || game === "shogi" ? "side" : "color"]: seats[index],
  }));
  const ids = players.map((player) => player.id);
  const state =
    game === "four-shogi"
      ? createFourShogiState({
          mode: "singles",
          players: { south: ids[0]!, west: ids[1]!, north: ids[2]!, east: ids[3]! },
        })
      : game === "shogi"
        ? createShogiState({ players: { south: ids[0]!, north: ids[1]! } })
        : game === "reversi"
          ? gameDefinitions.reversi.rules.createInitialState({})
          : game === "gomoku"
            ? gameDefinitions.gomoku.rules.createInitialState({ forbiddenRules: true })
            : gameDefinitions[game].rules.createInitialState({ mode: "singles" });
  const { repetitions: _repetitions, ...publicState } = { repetitions: undefined, ...state };
  return roomSchema.parse({
    ...base,
    status,
    players,
    roundId: crypto.randomUUID(),
    positionRevision: 0,
    game: publicState,
    clock: {
      remainingMainMs: Object.fromEntries(seats.map((seat) => [seat, 300000])),
      turnStartedAt: 1000,
      turnExpiresAt: 301000,
    },
  });
}
