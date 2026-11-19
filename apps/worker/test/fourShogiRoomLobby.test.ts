import { expect, test } from "vitest";
import { sides } from "@tetraboard/four-shogi";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  listRoomsContract,
  fourShogiRoomSchema,
} from "@tetraboard/protocol";
import {
  registerFourShogiRoomFixtures,
  request,
  json,
  create,
  get,
  setup,
  connect,
  start,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("ゲーム指定省略は旧リバーシ形式、将棋の作成・参加・一覧は独立する", async () => {
  const reversiResponse = await request(
    "/rooms",
    json({ name: "旧形式", quickPlay: false, mode: "singles" }),
  );
  expect(reversiResponse.status).toBe(201);
  const reversi = createRoomContract.response.parse(await reversiResponse.json()).room;
  expect(reversi.settings.game).toBe("four-reversi");
  expect(reversi.players[0]).toHaveProperty("color", null);
  expect(reversi).not.toHaveProperty("roundId");
  const shogi = await create();
  expect(shogi.room.settings.threePlayerAttackProhibited).toBe(true);
  expect(shogi.room.players[0]).toHaveProperty("side", null);
  expect(shogi.room.players[0]).not.toHaveProperty("color");
  const joined = await request(
    `/rooms/${shogi.room.id}/players`,
    json({ name: "将棋参加者", instanceId: shogi.room.instanceId }),
  );
  expect(joined.status).toBe(200);
  expect(
    fourShogiRoomSchema.parse(joinRoomContract.response.parse(await joined.json()).room).players,
  ).toHaveLength(2);
  await request(`/rooms/${reversi.id}`);
  await get(shogi.room.id);
  const list = async (game?: string) => {
    const rooms: import("@tetraboard/protocol").RoomPublicMetadata[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams();
      if (game) query.set("game", game);
      if (cursor) query.set("cursor", cursor);
      const page = listRoomsContract.response.parse(
        await (await request(`/rooms?${query}`)).json(),
      );
      rooms.push(...page.rooms);
      cursor = page.nextCursor;
    } while (cursor);
    return rooms;
  };
  expect((await list()).some((room) => room.id === reversi.id)).toBe(true);
  expect((await list()).some((room) => room.id === shogi.room.id)).toBe(false);
  expect((await list("four-shogi")).some((room) => room.id === shogi.room.id)).toBe(true);
  expect((await list("four-shogi")).every((room) => room.game === "four-shogi")).toBe(true);
});

test("将棋設定は待機中のホストのみ、CPU設定と準備・担当方向・観戦を配信する", async () => {
  const prepared = await setup();
  prepared.clients[1].send({ type: "room.three-player-attack.set", prohibited: false });
  expect(await prepared.clients[1].error()).toBe("forbidden");
  prepared.clients[0].send({ type: "room.three-player-attack.set", prohibited: false });
  let waiting = await prepared.clients[0].room(
    (room) => !room.settings.threePlayerAttackProhibited,
  );
  expect(waiting.players.every((player) => !player.ready)).toBe(true);
  for (let index = 0; index < 4; index++) {
    prepared.clients[index].send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  prepared.clients[0].send({ type: "room.game.start" });
  const room = await prepared.clients[0].room((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  expect(new Set(room.players.map((player) => player.side))).toEqual(new Set(sides));
  expect(room.game.turn).toBe("south");
  expect(room.game.board.flat().filter(Boolean)).toHaveLength(36);
  expect(room.game.threePlayerAttackProhibited).toBe(false);
  expect(room.legalActions.length).toBeGreaterThan(0);
  expect(room.checkState).toEqual({ south: false, west: false, north: false, east: false });
  expect(room.game).not.toHaveProperty("repetitions");
  prepared.clients[0].send({ type: "room.three-player-attack.set", prohibited: true });
  expect(await prepared.clients[0].error()).toBe("already_started");
  const observer = await connect(prepared.id);
  const snapshot = await observer.room((room) => room.status === "playing");
  expect(snapshot).toEqual(room);
});

test("対局中のホスト退出では公開一覧の旧ホスト名を消し、対局を継続する", async () => {
  const prepared = await start();
  const response = await request(`/rooms/${prepared.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${prepared.memberships[0].token}` },
  });
  expect(response.status).toBe(204);
  const snapshot = getRoomContract.response.parse(
    await (await request(`/rooms/${prepared.id}`)).json(),
  );
  expect(snapshot.presence.hostPlayerId).toBeNull();
  const room = fourShogiRoomSchema.parse(snapshot.room);
  expect(room.status).toBe("playing");
  expect(room.publicUpdatedAtMs).toBeGreaterThan(prepared.room.publicUpdatedAtMs);
  expect(room.players).toHaveLength(4);
  let cursor: string | null = null;
  let found: import("@tetraboard/protocol").RoomPublicMetadata | undefined;
  do {
    const query = new URLSearchParams({ game: "four-shogi" });
    if (cursor) query.set("cursor", cursor);
    const page = listRoomsContract.response.parse(await (await request(`/rooms?${query}`)).json());
    found = page.rooms.find((entry) => entry.id === prepared.id);
    cursor = page.nextCursor;
  } while (!found && cursor);
  expect(found).toMatchObject({ hostName: null, hostAvatarUrl: null, status: "playing" });
});
