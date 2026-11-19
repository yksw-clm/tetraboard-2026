import { z } from "zod";
import { isShogiRoom, fourReversiRoomSchema } from "@tetraboard/protocol";
import { env } from "cloudflare:workers";
import { afterEach, expect } from "vitest";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  leaveRoomContract,
  roomSocketContract,
  roomSchema as allRoomSchema,
  type GameId,
} from "@tetraboard/protocol";
import { type Side, type FourShogiAction } from "@tetraboard/four-shogi";
import { BoundarySocket, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
import { accountFixture, origin } from "./accountFixtures";

export const roomSchema = z.union([
  fourReversiRoomSchema,
  allRoomSchema.options[1],
  allRoomSchema.options[2],
]);

const entries: ReturnType<typeof createRoomContract.response.parse>[] = [];

const sockets: BoundarySocket[] = [];

export async function connect(entry: (typeof entries)[number]) {
  const response = await boundaryRequest(roomSocketContract.pathFor(entry.room.id), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Missing WebSocket");
  const socket = new BoundarySocket(response.webSocket);
  sockets.push(socket);
  await socket.waitFor("room.snapshot");
  socket.send({ type: "room.auth", token: entry.membership.token });
  await socket.waitFor(
    "room.authenticated",
    (message) => message.membership.playerId === entry.membership.playerId,
  );
  await socket.waitFor("room.snapshot", (message) =>
    message.presence.connectedPlayerIds.includes(entry.membership.playerId),
  );
  return socket;
}

export async function snapshot(id: string) {
  const response = await boundaryRequest(getRoomContract.pathFor(id));
  expect(response.status).toBe(200);
  const snapshot = getRoomContract.response.parse(await response.json());
  if (isShogiRoom(snapshot.room)) throw Error("Unexpected shogi fixture");
  return { ...snapshot, room: snapshot.room };
}

export async function start(game: GameId, quickPlay = false) {
  const members: (typeof entries)[number][] = [];
  for (let index = 0; index < (quickPlay ? 1 : 4); index++) {
    const account = await accountFixture();
    const response = await boundaryRequest(
      index === 0 ? createRoomContract.path : joinRoomContract.pathFor(members[0].room.id),
      {
        ...boundaryJson(index === 0 ? { game, mode: "singles", quickPlay } : {}),
        headers: account.headers,
      },
    );
    expect(response.status).toBe(index === 0 ? 201 : 200);
    const entry = (index === 0 ? createRoomContract.response : joinRoomContract.response).parse(
      await response.json(),
    );
    entries.push(entry);
    members.push(entry);
  }
  const clients = [];
  for (const entry of members) clients.push(await connect(entry));
  if (!quickPlay) {
    for (const [index, client] of clients.entries()) {
      client.send({ type: "room.ready.set", ready: true });
      await clients[0].waitFor(
        "room.snapshot",
        (message) => message.room.players.filter((player) => player.ready).length === index + 1,
      );
    }
  }
  clients[0].send({ type: "room.game.start" });
  const { room } = await clients[0].waitFor(
    "room.snapshot",
    (message) => message.room.status === "playing",
  );
  if (room.status !== "playing" || isShogiRoom(room))
    throw new Error("Not playing expected fixture");
  return { members, clients, room, stub: env.GAME_ROOM.getByName(room.id) };
}

export type SavedCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: FourShogiAction;
  applyAt: number;
};

export function registerRoomDeadlineBoundaryFixtures() {
  afterEach(async () => {
    try {
      for (const entry of entries.splice(0).reverse()) {
        const response = await boundaryRequest(leaveRoomContract.pathFor(entry.room.id), {
          method: "POST",
          headers: { Origin: origin, Authorization: `Bearer ${entry.membership.token}` },
        });
        // 期限で解放された資格・閉鎖済みルームも片付けの完了状態。
        expect([204, 401, 404]).toContain(response.status);
      }
    } finally {
      for (const socket of sockets.splice(0)) socket.close();
    }
  });
}
