import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { afterEach, expect, vi } from "vitest";
import {
  createRoomContract,
  getRoomContract,
  fourReversiRoomSchema as roomSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";

const sockets: WebSocket[] = [];

export const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));

export const create = (user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) =>
  request("/rooms", {
    method: "POST",
    headers: user?.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(user ? {} : { name: "ゲスト" }),
      quickPlay: false,
      mode: "singles",
      ...extra,
    }),
  });

export const join = (id: string, user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) =>
  request(`/rooms/${id}/players`, {
    method: "POST",
    headers: user?.headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(user ? {} : { name: "ゲスト" }), ...extra }),
  });

export async function created(user?: Awaited<ReturnType<typeof accountFixture>>, extra = {}) {
  const response = await create(user, extra);
  expect(response.status).toBe(201);
  return createRoomContract.response.parse(await response.json());
}

export async function snapshot(id: string) {
  return roomSchema.parse(
    getRoomContract.response.parse(await (await request(`/rooms/${id}`)).json()).room,
  );
}

export async function leave(id: string, token: string) {
  expect(
    (
      await request(`/rooms/${id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(204);
}

export async function expectSeated(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "account_seated" });
}

export async function attachAvatar(user: Awaited<ReturnType<typeof accountFixture>>) {
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, new Uint8Array([1, 2, 3]));
  await env.APP_DB.prepare("UPDATE user SET avatarKey = ?, image = ? WHERE id = ?")
    .bind(key, `/api/avatars/${key.slice(8, -5)}`, user.id)
    .run();
  return key;
}

export function nextMessage(socket: WebSocket, predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("Socket message timeout"));
    }, 2000);
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (predicate(message)) {
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(message);
      }
    };
    socket.addEventListener("message", listener);
  });
}

export async function connect(id: string, token: string) {
  const response = await request(`/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  socket.accept();
  sockets.push(socket);
  const auth = nextMessage(socket, (message) => message.type === "room.authenticated");
  socket.send(JSON.stringify({ type: "room.auth", token }));
  await auth;
  return socket;
}

export function registerAccountRoomsFixtures() {
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    vi.restoreAllMocks();
  });
}
