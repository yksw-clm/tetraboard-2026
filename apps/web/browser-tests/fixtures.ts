import { type Page, type WebSocketRoute } from "@playwright/test";
import { createInitialState } from "@tetraboard/four-reversi";
import {
  roomSchema,
  fourReversiRoomSchema,
  roomTimeControl,
  roomSocketContract,
  type Room,
  type FourReversiRoom,
  type RoomMembership,
} from "@tetraboard/protocol";

export const widths = [320, 390, 650, 651, 767, 768, 900, 901, 1024, 1279, 1280, 1440];
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

// HTTPとWebSocketの境界だけを制御し、画面とhookは本番と同じものを実行します。
export async function mockRoom(
  page: Page,
  initial: Room = waitingRoom(),
  asPlayer = true,
  identity: RoomMembership = membership,
) {
  await page.route("**/api/account/session", (route) => route.fulfill({ json: { user: null } }));
  let room = initial;
  const received: ReturnType<typeof roomSocketContract.clientMessage.parse>[] = [];
  let presence = { hostPlayerId: playerIds[0]!, connectedPlayerIds: room.players.map((p) => p.id) };
  const sockets = new Set<WebSocketRoute>();
  let paused = false;
  const snapshot = () => ({
    room,
    presence,
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
  await page.route("**/api/rooms/12345/me", (route) => route.fulfill({ json: identity }));
  await page.routeWebSocket("**/api/rooms/12345/ws?*", (socket) => {
    sockets.add(socket);
    if (!paused) send(socket, { type: "room.snapshot", ...snapshot() });
    send(socket, { type: "room.chat.snapshot", messages: [] });
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((raw) => {
      const message = roomSocketContract.clientMessage.parse(JSON.parse(String(raw)));
      received.push(message);
      if (message.type === "room.auth")
        send(socket, { type: "room.authenticated", membership: identity });
    });
  });
  return {
    received,
    get connectedSocketCount() {
      return sockets.size;
    },
    disconnect() {
      paused = true;
      for (const socket of [...sockets]) socket.close({ code: 1012 });
    },
    reconnect() {
      paused = false;
      for (const socket of sockets) send(socket, { type: "room.snapshot", ...snapshot() });
    },
    update(
      next: Room,
      nextPresence = {
        hostPlayerId: playerIds[0]!,
        connectedPlayerIds: next.players.map((p) => p.id),
      },
    ) {
      presence = nextPresence;
      room = roomSchema.parse(next);
      for (const socket of sockets) send(socket, { type: "room.snapshot", ...snapshot() });
    },
    send(message: unknown) {
      for (const socket of sockets) send(socket, message);
    },
  };
}

export async function mockLobby(page: Page) {
  await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
  await page.route(/\/api\/games\/four-(?:reversi|shogi)\/rankings$/, (route) =>
    route.fulfill({
      json: { singles: { first: [], total: [] }, doubles: { wins: [], total: [] } },
    }),
  );
  await page.route("**/api/account/session", (route) => route.fulfill({ json: { user: null } }));
  await page.route(/\/api\/rooms(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { rooms: [], nextCursor: null } }),
  );
}
