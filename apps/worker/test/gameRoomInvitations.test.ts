import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { joinRoomContract, fourReversiRoomSchema as roomSchema } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import {
  registerGameRoomFixtures,
  createRoom,
  authenticatedRoom,
  baseUrl,
  joinRoom,
  leaveRoom,
  getRoom,
  startFourPlayerRoom,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("招待先と同じ世代に参加し、既存の番号参加も引き続き利用できる", async () => {
  const { room, membership } = await createRoom();
  const host = await authenticatedRoom(room.id, membership.token);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: room.instanceId }),
    }),
  );
  expect(response.status).toBe(200);
  const joined = joinRoomContract.response.parse(await response.json());
  expect(
    joined.room.players.find((player) => player.id === joined.membership.playerId)?.ready,
  ).toBe(false);
  await host.nextSnapshotWhere((snapshot) => snapshot.players.length === 2);
  const player = await authenticatedRoom(room.id, joined.membership.token);
  player.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((snapshot) =>
    snapshot.players.some((entry) => entry.id === joined.membership.playerId && entry.ready),
  );
  await joinRoom(room.id, "番号から参加");
  const socketResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(socketResponse.status).toBe(101);
  socketResponse.webSocket!.accept();
  socketResponse.webSocket!.close();
});

test("閉鎖・番号再利用後の古い招待は参加とWebSocket接続を拒否する", async () => {
  const { room, membership } = await createRoom();
  expect((await leaveRoom(room.id, membership.token)).status).toBe(204);
  const request = () =>
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: room.instanceId }),
    });
  expect((await exports.default.fetch(request())).status).toBe(404);
  const replacement = roomSchema.parse({
    ...room,
    instanceId: crypto.randomUUID(),
    lastActivityAtMs: Date.now(),
    players: [{ ...room.players[0], id: crypto.randomUUID(), reconnectDeadline: null }],
  });
  await env.GAME_ROOM.getByName(room.id).createRoom(replacement, "c".repeat(64));
  const before = await getRoom(room.id);
  const response = await exports.default.fetch(request());
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "room_changed" });
  const socketResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(socketResponse.status).toBe(410);
  expect(await socketResponse.json()).toEqual({ error: "room_changed" });
  expect((await getRoom(room.id)).players).toEqual(before.players);
});

test("招待の不正な識別子、参加前の満室化・開始を案内する", async () => {
  const setup = await startFourPlayerRoom();
  for (const instanceId of ["invalid", setup.room.instanceId]) {
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${baseUrl}/rooms/${setup.id}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "招待された人", instanceId }),
      }),
    );
    expect(response.status).toBe(instanceId === "invalid" ? 400 : 409);
    expect(await response.json()).toEqual({
      error: instanceId === "invalid" ? "invalid_request" : "room_started",
    });
  }
  const full = await createRoom(true);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${full.room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: full.room.instanceId }),
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "room_full" });
  expect(
    (
      await exports.default.fetch(
        new AcceptedGameRequest(`${baseUrl}/rooms/${full.room.id}/ws?instanceId=invalid`, {
          headers: { Upgrade: "websocket" },
        }),
      )
    ).status,
  ).toBe(400);
});
