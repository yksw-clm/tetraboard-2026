import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { D1DeletionJobs } from "../src/adapters/privacy/deletionJobs";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

test("現行の旧席は索引から分かるが、移行前の DO にだけ残る保存待ちは全ルーム登録で拾う", async () => {
  const db = env.APP_DB;
  const user = await accountFixture();
  const fixtures = new RoomBoundaryFixtures();
  const current = await fixtures.create(
    { game: "reversi", name: "現在の席", quickPlay: false },
    user.cookie,
  );
  await fixtures.leave(current);
  const legacy = await fixtures.create({
    game: "four-reversi",
    mode: "singles",
    name: "現在のホスト",
    quickPlay: false,
  });
  const roomId = legacy.room.id;
  const stub = env.GAME_ROOM.getByName(roomId);
  const record = { ...humanFixtureRecord(user.id, 1), roomId, instanceId: "legacy-instance" };
  record.participants[0].name = "移行前の保存名";
  const key = `match-pending:${record.id}`;
  // 0014 の適用時に退室済みで、旧世代の未保存棋譜だけが KV に残ったルームを再現します。
  await runInDurableObject(stub, async (_, ctx) => {
    ctx.storage.kv.put(key, { record, retryAtMs: Number.MAX_SAFE_INTEGER });
  });
  const indexedRooms = await db
    .prepare(`
    SELECT room_id FROM privacy_room_accounts WHERE account_id=?
    UNION SELECT room_id FROM privacy_room_players WHERE account_id=?
    UNION SELECT room_id FROM account_room_seats WHERE account_id=?
    UNION SELECT room_id FROM match_participant_accounts WHERE account_id=?
  `)
    .bind(user.id, user.id, user.id, user.id)
    .all<{ room_id: string }>();
  expect(indexedRooms.results).toEqual([{ room_id: current.room.id }]);
  expect(
    await db
      .prepare("SELECT id FROM matches WHERE id=? UNION SELECT id FROM match_uploads WHERE id=?")
      .bind(record.id, record.id)
      .first(),
  ).toBeNull();

  expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);

  const queuedRooms = await new D1DeletionJobs(db).readRooms(user.id, 100);
  expect(queuedRooms).toEqual(expect.arrayContaining([current.room.id, roomId]));
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, ctx) => {
    const pending = ctx.storage.kv.get<{ record: typeof record }>(key);
    expect(pending?.record.participants[0]).toMatchObject({
      name: "退会したプレイヤー",
      accountId: null,
      retired: true,
    });
  });
});
