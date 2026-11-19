import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { listRoomsContract } from "@tetraboard/protocol";
import { gameIds } from "@tetraboard/protocol/games";
import { lobbyRoomCardsSchema, lobbyRoomsSchema } from "@tetraboard/protocol/general-lobby";
import worker from "../src/worker";
import { writeRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { origin } from "./accountFixtures";
import {
  registerLobbyRoomCardsFixtures,
  db,
  indexed,
  cards,
  request,
  fixtures,
  waitForIndex,
} from "./lobbyRoomCardsFixtures";

registerLobbyRoomCardsFixtures();

test("カード一覧は6ゲームを同じ優先順で20件ずつ返し、絞込後の全件数を返す", async () => {
  for (let index = 0; index < 30; index++) {
    await writeRoomIndex(db, indexed(10000 + index, gameIds[index % 6]!, index % 3));
  }
  const first = await cards();
  expect(first.totalCount).toBe(30);
  expect(first.rooms).toHaveLength(20);
  expect(first.rooms.slice(0, 10).every((room) => room.openSeats > 0)).toBe(true);
  expect(
    first.rooms.slice(10).every((room) => room.status === "waiting" && room.openSeats === 0),
  ).toBe(true);
  const second = await cards(`&cursor=${first.nextCursor}`);
  expect(second.totalCount).toBe(30);
  expect(second.rooms).toHaveLength(10);
  expect(second.rooms.every((room) => room.status === "playing")).toBe(true);
  expect(new Set([...first.rooms, ...second.rooms].map((room) => room.id)).size).toBe(30);
  const playable = await cards("&joinable=true");
  expect(playable.totalCount).toBe(10);
  expect(playable.rooms).toHaveLength(10);
  const twos = await cards("&capacity=2&joinable=false");
  expect(twos.totalCount).toBe(15);
  expect(twos.rooms.every((room) => room.capacity === 2)).toBe(true);
  const shogi = await cards("&game=four-shogi&mode=singles");
  expect(shogi.totalCount).toBe(5);
  expect(shogi.rooms.every((room) => room.game === "four-shogi" && room.mode === "singles")).toBe(
    true,
  );
  expect((await cards("&game=four-shogi&mode=doubles")).totalCount).toBe(0);
  expect((await cards("&game=four-shogi&capacity=2")).rooms).toHaveLength(0);
  for (const suffix of [
    "?view=cards&mode=standard",
    "?view=cards&joinable=1",
    "?view=cards&game=shogi&mode=singles",
    "?view=cards&cursor=3:100:12345",
    "?game=shogi",
  ]) {
    expect((await request(suffix)).status).toBe(400);
  }
});

test("旧一覧の形を維持し、cardsの各人間席には公開プロフィール参照だけを加える", async () => {
  const pending = indexed(12345, "four-reversi");
  const playerId = pending.metadata.participantPreviews![0]!.playerId;
  await writeRoomIndex(db, pending);
  const old = (await (await request()).json()) as { rooms: Record<string, unknown>[] };
  expect(lobbyRoomsSchema.parse(old).rooms).toHaveLength(1);
  expect(old).not.toHaveProperty("totalCount");
  expect(old.rooms[0]).not.toHaveProperty("participants");
  const legacy = await worker.fetch(
    new Request(`${origin}/api/rooms`),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
  expect(listRoomsContract.response.parse(await legacy.json()).rooms).toHaveLength(1);
  const page = await cards();
  expect(page.rooms[0]?.participants).toEqual([
    {
      kind: "human",
      avatarUrl: null,
      profileTarget: {
        source: "room",
        roomId: "12345",
        instanceId: pending.metadata.instanceId,
        playerId,
      },
    },
  ]);
  expect(page.rooms[0]?.profileTarget).toMatchObject({
    source: "room",
    playerId: pending.metadata.hostPlayerId,
  });
  expect(page.rooms[0]?.participants[0]).not.toHaveProperty("playerId");
  const stored = JSON.parse(
    (await db
      .prepare("SELECT participants_json FROM room_index WHERE room_id='12345'")
      .first<{ participants_json: string }>())!.participants_json,
  );
  expect(stored[0].appearance).not.toHaveProperty("profileTarget");
});

test("種別は要求時だけ返し、状態・参加者・世代と古いrevisionの保護を維持する", async () => {
  const kinds = ["rated", "tournament", "normal", "unknown"] as const;
  for (const [index, matchKind] of kinds.entries()) {
    const pending = indexed(21000 + index, "four-shogi");
    pending.metadata.matchKind = matchKind;
    await writeRoomIndex(db, pending);
    await writeRoomIndex(db, {
      ...pending,
      revision: 0,
      metadata: { ...pending.metadata, matchKind: "normal" },
    });
  }
  expect((await cards()).rooms.every((room) => !("matchKind" in room))).toBe(true);
  const result = await cards("&includeMatchKind=1");
  for (const [index, kind] of kinds.entries()) {
    const room = result.rooms.find((room) => room.id === String(21000 + index))!;
    expect(room.matchKind).toBe(kind);
    expect(room.participants).toHaveLength(1);
    expect(room.status).toBe("waiting");
  }
  expect((await request("?view=cards&includeMatchKind=0")).status).toBe(400);
});

test("稼働中の旧索引の種別をルームから再発行し、公開メタ情報の旧応答には追加しない", async () => {
  const entry = await fixtures.create({
    name: "種別確認",
    game: "four-reversi",
    mode: "singles",
    quickPlay: false,
  });
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await env.APP_DB.prepare("UPDATE room_index SET match_kind=NULL WHERE room_id=?")
    .bind(entry.room.id)
    .run();
  const result = await cards("&includeMatchKind=1&game=four-reversi", env.APP_DB);
  expect(result.rooms.find((room) => room.id === entry.room.id)?.matchKind).toBe("normal");
  expect(await stub.getPublicMetadata()).not.toHaveProperty("matchKind");
  expect(await stub.getPublicMetadata(true)).not.toHaveProperty("matchKind");
});

test("旧索引の種別を取得できない場合は種別不明とし、通常対局に決めつけない", async () => {
  await writeRoomIndex(db, indexed(22000, "four-reversi"));
  const response = await worker.fetch(
    new Request(`${origin}/api/lobby/rooms?view=cards&includeMatchKind=1`),
    {
      ...env,
      APP_DB: db,
      GAME_ROOM: {
        getByName: () => ({ refreshLobbyIndex: () => Promise.reject(new Error("Unavailable")) }),
      } as unknown as Env["GAME_ROOM"],
    },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(lobbyRoomCardsSchema.parse(await response.json()).rooms[0]?.matchKind).toBe("unknown");
});

test("通し番号はカードの明示要求時だけ返し、旧応答と通常・未採番ルームに混入しない", async () => {
  for (const [index, kind] of (["rated", "tournament", "normal", "unknown"] as const).entries()) {
    const pending = indexed(91000 + index, "four-reversi");
    pending.metadata.matchKind = kind;
    pending.metadata.matchSequence = 12;
    await writeRoomIndex(db, pending);
  }
  const old = indexed(91004, "shogi");
  old.metadata.matchKind = "rated";
  await writeRoomIndex(db, old);
  expect(
    (await cards("&includeMatchKind=1")).rooms.every((room) => !("matchSequence" in room)),
  ).toBe(true);
  const result = await cards("&includeMatchKind=1&includeMatchSequence=1");
  for (const room of result.rooms) {
    if (room.id === "91000" || room.id === "91001") expect(room.matchSequence).toBe(12);
    else expect(room).not.toHaveProperty("matchSequence");
  }
  for (const query of ["?view=cards&includeMatchSequence=0", "?includeMatchSequence=1"])
    expect((await request(query)).status).toBe(400);
  const newer = indexed(91000, "four-reversi");
  newer.revision = 2;
  newer.metadata.matchKind = "normal";
  await writeRoomIndex(db, newer);
  await writeRoomIndex(db, {
    ...newer,
    revision: 1,
    metadata: { ...newer.metadata, matchKind: "rated", matchSequence: 999 },
  });
  expect(
    (await cards("&includeMatchKind=1&includeMatchSequence=1")).rooms.find(
      (room) => room.id === "91000",
    ),
  ).not.toHaveProperty("matchSequence");
});
