import { createInitialState } from "@tetraboard/four-reversi";
import { fourReversiRoomSchema, roomTimeControl, type FourReversiRoom } from "@tetraboard/protocol";

export const now = 1_790_899_200_000;
export const playerIds = [1, 2, 3, 4].map((id) => `00000000-0000-4000-8000-00000000000${id}`);
export const membership = { playerId: playerIds[0]!, role: "host" as const };
export const token = "a".repeat(64);

export function waitingRoom() {
  const room = fourReversiRoomSchema.parse({
    id: "12345",
    instanceId: "00000000-0000-4000-8000-000000000010",
    status: "waiting",
    settings: { game: "four-reversi", mode: "singles", timeControl: roomTimeControl },
    publicUpdatedAtMs: now,
    lastActivityAtMs: now,
    players: playerIds.map((id, index) => ({
      id,
      name: index === 0 ? "あいうえおかきくけこ" : `参加者${index + 1}`,
      kind: "human",
      ready: false,
      color: null,
      reconnectDeadline: null,
    })),
    game: null,
    clock: null,
    lastRound: null,
  });
  if (room.status !== "waiting") throw new Error("Expected waiting fixture");
  return room;
}

export function playingRoom(): FourReversiRoom {
  const room = waitingRoom();
  return fourReversiRoomSchema.parse({
    ...room,
    status: "playing",
    players: room.players.map((player, index) => ({
      ...player,
      ready: true,
      color: ["black", "white", "red", "blue"][index],
    })),
    game: createInitialState("singles"),
    clock: {
      remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
}
