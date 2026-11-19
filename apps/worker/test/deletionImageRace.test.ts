import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { D1DeletionJobs, deletePrivacyImages } from "../src/adapters/privacy/deletionJobs";
import { reapplyDeletionCascade } from "../src/flows/accountPurge/deletionCascade";
import { processDeletions } from "../src/flows/accountPurge/processDeletions";
import { markDeleted } from "./guestFenceFixtures";
import { privacyConcurrencyFixture } from "./privacyConcurrencyFixture";

async function imageKeys(db: D1Database, accountId: string) {
  const { results } = await db
    .prepare("SELECT key FROM deletion_images WHERE account_id=? ORDER BY key")
    .bind(accountId)
    .all<{ key: string }>();
  return results.map(({ key }) => key);
}

function completion(db: D1Database, accountId: string) {
  return db
    .prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
    .bind(accountId)
    .first<number | null>("completed_at_ms");
}

test.each(["完了より先", "完了より後"] as const)(
  "画像の削除予約を %s に再作成しても、完了済みの退会にキーは残らない",
  async (order) => {
    const { db } = await privacyConcurrencyFixture();
    const bindings = { ...env, APP_DB: db };
    const accountId = crypto.randomUUID();
    const seatAvatar = `avatars/${crypto.randomUUID()}.webp`;
    const upload = `avatars/${crypto.randomUUID()}.webp`;
    await markDeleted(db, accountId);
    await db.batch([
      db
        .prepare("INSERT INTO privacy_room_players VALUES (?,?,?,?,?)")
        .bind(accountId, "old-room", "old-instance", "old-player", seatAvatar),
      db.prepare("INSERT INTO privacy_avatar_uploads VALUES (?,?,1)").bind(upload, accountId),
    ]);
    await reapplyDeletionCascade(bindings, accountId);
    const keys = [seatAvatar, upload].sort();
    expect(await imageKeys(db, accountId)).toEqual(keys);
    await deletePrivacyImages(db, env.OBJECT_STORAGE, accountId);
    expect(await imageKeys(db, accountId)).toEqual([]);

    // 画像を消化した処理の完了と、先にジョブを読んだ別の処理の再適用を順に実行します。
    const jobs = new D1DeletionJobs(db);
    if (order === "完了より先") {
      await reapplyDeletionCascade(bindings, accountId);
      await jobs.completeJob(accountId, 2);
      expect(await imageKeys(db, accountId)).toEqual(keys);
      expect(await completion(db, accountId)).toBeNull();
      await processDeletions(bindings);
      expect(await completion(db, accountId)).toEqual(expect.any(Number));
    } else {
      await jobs.completeJob(accountId, 2);
      await reapplyDeletionCascade(bindings, accountId);
      expect(await completion(db, accountId)).toBe(2);
    }
    expect(await imageKeys(db, accountId)).toEqual([]);
  },
);

test("完了した退会のルーム削除が遅れて届いても、画像の削除予約は復活しない", async () => {
  const db = env.APP_DB;
  const accountId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await markDeleted(db, accountId);
  const stub = env.GAME_ROOM.getByName(`privacy-late-purge:${accountId}`);
  await runInDurableObject(stub, async (_, state) => {
    state.storage.kv.put(`seat-account:${playerId}`, {
      accountId,
      playerId,
      operationId: "late-purge",
      instanceId: "late-purge",
      avatarKey: `avatars/${crypto.randomUUID()}.webp`,
      occupying: false,
    });
    state.storage.kv.put("late-purge-record", {
      accountId,
      playerId,
      avatarKey: `avatars/${crypto.randomUUID()}.webp`,
    });
  });
  await new D1DeletionJobs(db).completeJob(accountId, 2);

  await stub.purgeAccount(accountId);

  expect(await completion(db, accountId)).toBe(2);
  expect(await imageKeys(db, accountId)).toEqual([]);
});
