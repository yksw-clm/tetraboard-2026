import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { writeRoomIndex, type PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { markDeleted } from "./guestFenceFixtures";
import { seedMerge } from "./guestMergeRecordFixtures";

const db = env.APP_DB;

function roomFixture(id: string) {
  const avatarUrl = `/api/avatars/${crypto.randomUUID()}`;
  const participants = [
    { playerId: crypto.randomUUID(), appearance: { kind: "human", avatarUrl } },
    { playerId: crypto.randomUUID(), appearance: { kind: "human", avatarUrl } },
    {
      playerId: crypto.randomUUID(),
      appearance: { kind: "human", avatarUrl: null, isGuest: true },
    },
    { playerId: crypto.randomUUID(), appearance: { kind: "cpu", level: 2 } },
  ] as const;
  const pending = {
    revision: 2,
    closed: false,
    retryAtMs: 0,
    metadata: {
      id,
      game: "four-reversi",
      mode: "singles",
      timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
      status: "waiting",
      hostName: "ホスト",
      hostAvatarUrl: avatarUrl,
      humanCount: 3,
      cpuCount: 1,
      capacity: 4,
      openSeats: 0,
      updatedAtMs: 1000,
      instanceId: crypto.randomUUID(),
      hostPlayerId: participants[0].playerId,
      participantPreviews: [...participants],
    },
  } satisfies PendingRoomIndex;
  return { pending, participants };
}

function readIndex(db: D1Database, roomId: string) {
  return db
    .prepare(`SELECT revision, instance_id, host_name, host_avatar_url, host_player_id,
      participants_json FROM room_index WHERE room_id=?`)
    .bind(roomId)
    .first();
}

test.each([
  { id: "16001", name: "退会なしの挿入", retiredSeats: [] },
  { id: "16002", name: "ホストが退会済みの挿入", retiredSeats: [0] },
  { id: "16003", name: "参加者1人が退会済みの挿入", retiredSeats: [1] },
  { id: "16004", name: "ホストと統合先が退会済みの挿入", retiredSeats: [0, 1], mergedSeat: 1 },
  { id: "16005", name: "ホストの統合先が退会済みの挿入", retiredSeats: [0], mergedSeat: 0 },
  { id: "16006", name: "退会済みホスト名の更新", retiredSeats: [0], update: "host" },
  {
    id: "16007",
    name: "退会済み参加者を含むJSONの更新",
    retiredSeats: [1],
    update: "participants",
  },
  { id: "16008", name: "新世代の席での伏せ字", retiredSeats: [1], update: "generation" },
])("$name", async ({ id, retiredSeats, mergedSeat, update }) => {
  const { pending, participants } = roomFixture(id);
  const { metadata } = pending;
  const previous = { ...metadata };
  if (update === "host") previous.hostName = "変更前の名前";
  if (update === "participants") previous.participantPreviews = [participants[0]];
  if (update === "generation") previous.instanceId = crypto.randomUUID();
  if (update) await writeRoomIndex(db, { ...pending, revision: 1, metadata: previous });

  // 同じ席IDが旧世代で退会済みでも、新世代のホストには影響しません。
  const seats = update === "generation" ? [...retiredSeats, 0] : retiredSeats;
  for (const seat of seats) {
    const accountId = crypto.randomUUID();
    const alias = seat === mergedSeat ? crypto.randomUUID() : accountId;
    const instanceId =
      update === "generation" && seat === 0 ? previous.instanceId : metadata.instanceId;
    if (seat === mergedSeat) await seedMerge(db, alias, accountId);
    await db
      .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)")
      .bind(alias, id, instanceId, participants[seat]!.playerId)
      .run();
    await markDeleted(db, accountId);
  }

  await writeRoomIndex(db, pending);

  const retiredHost = retiredSeats.includes(0) && mergedSeat !== 0;
  expect(await readIndex(db, id)).toEqual({
    revision: pending.revision,
    instance_id: metadata.instanceId,
    host_name: retiredHost ? "退会したプレイヤー" : metadata.hostName,
    host_avatar_url: retiredHost ? null : metadata.hostAvatarUrl,
    host_player_id: retiredHost ? null : metadata.hostPlayerId,
    participants_json: JSON.stringify(
      participants.map((participant, seat) =>
        retiredSeats.includes(seat)
          ? { ...participant, appearance: { kind: "human", avatarUrl: null, retired: true } }
          : participant,
      ),
    ),
  });
});

test("旧形式の世代と参加者プレビューのNULLを保持する", async () => {
  const { pending } = roomFixture("16009");
  const {
    instanceId: _instanceId,
    participantPreviews: _participantPreviews,
    ...metadata
  } = pending.metadata;

  await writeRoomIndex(db, { ...pending, metadata });

  expect(await readIndex(db, metadata.id)).toEqual({
    revision: pending.revision,
    instance_id: null,
    host_name: metadata.hostName,
    host_avatar_url: metadata.hostAvatarUrl,
    host_player_id: metadata.hostPlayerId,
    participants_json: null,
  });
});
