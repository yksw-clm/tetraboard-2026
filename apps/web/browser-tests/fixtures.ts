import { type Page, type WebSocketRoute } from "@playwright/test";
import { createInitialState } from "@tetraboard/four-reversi";
import { roomSchema, roomTimeControl, roomSocketContract, type Room } from "@tetraboard/protocol";

export const widths = [320, 390, 650, 651, 767, 768, 900, 901, 1024, 1279, 1280, 1440];
export const now = 1_790_899_200_000;
export const playerIds = [1, 2, 3, 4].map((id) => `00000000-0000-4000-8000-00000000000${id}`);
export const membership = { playerId: playerIds[0]!, role: "host" as const };
export const token = "a".repeat(64);

export function waitingRoom(): Room {
  return roomSchema.parse({
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
}

export function playingRoom(): Room {
  const room = waitingRoom();
  return roomSchema.parse({
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

// HTTPとWebSocketの境界だけを制御し、画面とhookは本番と同じものを実行します。
export async function mockRoom(page: Page, initial = waitingRoom(), asPlayer = true) {
  let room = initial;
  const sockets = new Set<WebSocketRoute>();
  const snapshot = () => ({
    room,
    presence: { hostPlayerId: playerIds[0], connectedPlayerIds: room.players.map((p) => p.id) },
    serverNowMs: now,
  });
  const send = (socket: WebSocketRoute, message: unknown) =>
    socket.send(JSON.stringify(roomSocketContract.message.parse(message)));

  await page.clock.setFixedTime(now);
  if (asPlayer) {
    await page.addInitScript(
      ({ token }) => {
        sessionStorage.setItem("tetraboard:room:12345:membership", token);
      },
      { token },
    );
  }
  await page.route("**/api/rooms/12345", (route) => route.fulfill({ json: snapshot() }));
  await page.route("**/api/rooms/12345/me", (route) => route.fulfill({ json: membership }));
  await page.routeWebSocket("**/api/rooms/12345/ws?*", (socket) => {
    sockets.add(socket);
    send(socket, { type: "room.snapshot", ...snapshot() });
    send(socket, { type: "room.chat.snapshot", messages: [] });
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((raw) => {
      const message = roomSocketContract.clientMessage.parse(JSON.parse(String(raw)));
      if (message.type === "room.auth") send(socket, { type: "room.authenticated", membership });
    });
  });
  return {
    update(next: Room) {
      room = roomSchema.parse(next);
      for (const socket of sockets) send(socket, { type: "room.snapshot", ...snapshot() });
    },
    send(message: unknown) {
      for (const socket of sockets) send(socket, message);
    },
  };
}

export async function mockLobby(page: Page) {
  await page.route("**/api/rooms", (route) =>
    route.fulfill({ json: { rooms: [], nextCursor: null } }),
  );
}
