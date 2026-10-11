import { createInitialState, colors, type GameMode } from "@tetraboard/four-gomoku";
import { fourGomokuRoomSchema } from "@tetraboard/protocol";
import { waitingRoom, now } from "./rooms";
export function fourGomokuWaitingRoom(mode: GameMode = "singles") {
  const room = waitingRoom();
  return fourGomokuRoomSchema.parse({
    ...room,
    settings: { game: "four-gomoku", mode, timeControl: room.settings.timeControl },
    roundId: null,
    positionRevision: 0,
  });
}
export function fourGomokuPlayingRoom(mode: GameMode = "singles") {
  const room = fourGomokuWaitingRoom(mode);
  return fourGomokuRoomSchema.parse({
    ...room,
    status: "playing",
    roundId: "c1000000-0000-4000-8000-000000000001",
    players: room.players.map((p, i) => ({ ...p, color: colors[i] })),
    game: createInitialState(mode),
    clock: {
      remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
}
