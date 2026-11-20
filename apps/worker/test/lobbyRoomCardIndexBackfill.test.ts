import { fixTestTime } from "./fixedTimeFixture";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { writeRoomIndex, type PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { markDeleted } from "./guestFenceFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import {
  registerLobbyRoomCardsFixtures,
  accountRoom,
  waitForIndex,
  cards,
  entries,
  request,
} from "./lobbyRoomCardsFixtures";

registerLobbyRoomCardsFixtures();

test("旧NULL索引はDO再作成後も公開時刻を変えず補完し、古い更新は新revisionを上書きしない", async () => {
  const { entry, avatarId, stub } = await accountRoom();
  const before = await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare(
    "UPDATE room_index SET participants_json=NULL,instance_id=NULL WHERE room_id=?",
  )
    .bind(entry.room.id)
    .run();
  await evictDurableObject(stub);
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(listed.instanceId).toBe(entry.room.instanceId);
  expect(listed.participants).toEqual([
    {
      kind: "human",
      avatarUrl: `/api/avatars/${avatarId}`,
      profileTarget: {
        source: "room",
        roomId: entry.room.id,
        instanceId: entry.room.instanceId,
        playerId: entry.membership.playerId,
      },
    },
  ]);
  const after = await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.updated_at_ms).toBe(before.updated_at_ms);
  await writeRoomIndex(env.APP_DB, {
    revision: before.revision,
    closed: false,
    retryAtMs: 0,
    metadata: { ...listed, hostName: "古いホスト" },
  });
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)?.hostName,
  ).toBe(listed.hostName);
});

test("補完では再利用された番号の現在世代をD1から読み直し、閉鎖済みの旧行は除外する", async () => {
  const { entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare(
    "UPDATE room_index SET participants_json=NULL,instance_id=? WHERE room_id=?",
  )
    .bind(crypto.randomUUID(), entry.room.id)
    .run();
  const corrected = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(corrected.instanceId).toBe(entry.room.instanceId);
  expect(
    (
      await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${entry.membership.token}` },
      })
    ).status,
  ).toBe(204);
  entries.splice(entries.indexOf(entry), 1);
  await vi.waitFor(async () => expect(await stub.getPublicMetadata()).toBeNull());
  await env.APP_DB.prepare("UPDATE room_index SET closed=0,participants_json=NULL WHERE room_id=?")
    .bind(entry.room.id)
    .run();
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id),
  ).toBeUndefined();
});

test("NULL補完はDOに旧画像が残っていてもD1で伏せ字にした公開情報を返す", async () => {
  const { user, avatarId, entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare("UPDATE room_index SET participants_json=NULL WHERE room_id=?")
    .bind(entry.room.id)
    .run();
  // 旧情報が残る DO から索引を補完するときの書き込みを検証します。
  await markDeleted(env.APP_DB, user.id);
  expect((await stub.getPublicMetadata())?.hostAvatarUrl).toBe(`/api/avatars/${avatarId}`);
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(listed.participants).toEqual([
    { kind: "human", avatarUrl: null, retired: true, profileTarget: null },
  ]);
  expect(listed.hostAvatarUrl).toBeNull();
  expect(listed.profileTarget).toBeNull();
});

test("補完のD1失敗は取得失敗として返し、既存の索引再送で復旧できる", async () => {
  fixTestTime();
  const { entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.exec("ALTER TABLE room_index RENAME TO lobby_room_index_unavailable");
  try {
    await stub.refreshLobbyIndex(entry.room.instanceId, 100);
    expect((await request("?view=cards", env.APP_DB)).status).toBe(503);
  } finally {
    await env.APP_DB.exec("ALTER TABLE lobby_room_index_unavailable RENAME TO room_index");
  }
  await runInDurableObject(stub, async (_instance, state) => {
    const pending = state.storage.kv.get<PendingRoomIndex>("room-index-pending")!;
    expect(pending.retryAtMs).toBeGreaterThan(Date.now());
    state.storage.kv.put("room-index-pending", { ...pending, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id),
  ).toBeDefined();
});
