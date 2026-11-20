import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { writeRoomIndex, type PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import type { AnalyticsMatch } from "../src/usageEvents/matches";
import { accountFixture } from "./accountFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { unusedRoomId } from "./unusedRoomId";
import { tombstone, request, processFixtureDeletion } from "./privacyFixtures";

test("DO内の席・保存待ち・直前局・チャットの本人表示と画像参照を削除する", async () => {
  const user = await accountFixture();
  expect(await tombstone(user.id)).toBe(true);
  const stub = env.GAME_ROOM.getByName("privacy-purge-fixture"),
    playerId = crypto.randomUUID(),
    avatarKey = `avatars/${crypto.randomUUID()}.webp`;
  await runInDurableObject(stub, async (_, state) => {
    state.storage.kv.put(`seat-account:${playerId}`, {
      accountId: user.id,
      playerId,
      operationId: "privacy-operation",
      instanceId: "privacy-instance",
      avatarKey,
      name: "秘密名",
      occupying: false,
    });
    state.storage.kv.put(`player-token:${playerId}`, "oldtoken");
    state.storage.kv.put("membership:oldtoken", { playerId, role: "player" });
    state.storage.kv.put("privacy-saved", {
      participants: [
        { id: playerId, kind: "human", accountId: user.id, name: "秘密名" },
        { id: "guest", kind: "human", accountId: null, name: "ゲスト名" },
      ],
      lastRound: {
        players: [
          {
            id: playerId,
            name: "秘密名",
            appearance: { kind: "human", avatarUrl: "/api/avatars/secret" },
          },
        ],
      },
    });
    state.storage.kv.put("chat", [
      {
        id: crypto.randomUUID(),
        senderId: playerId,
        senderName: "秘密名",
        text: "挨拶",
        sentAtMs: Date.now(),
      },
    ]);
    state.storage.kv.put("analytics-active", {
      participants: [{ playerId, accountId: user.id, visitorId: crypto.randomUUID() }],
    });
  });
  await stub.purgeAccount(user.id);
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, state) => {
    const values = [...state.storage.kv.list()].map(([, value]) => value);
    const json = JSON.stringify(values);
    expect(json).not.toContain("秘密名");
    expect(json).not.toContain(user.id);
    expect(json).not.toContain("/api/avatars/secret");
    expect(json).toContain("ゲスト名");
    expect(state.storage.kv.get("membership:oldtoken")).toBeUndefined();
    expect(state.storage.kv.get(`seat-account:${playerId}`)).toBeUndefined();
    expect(state.storage.kv.get("analytics-active")).toEqual({
      participants: [{ playerId, accountId: null, visitorId: null }],
    });
  });
  expect(
    await env.APP_DB.prepare("SELECT key FROM deletion_images WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ key: avatarKey });
});

test("退会はDOの計測識別を除去する", async () => {
  const user = await accountFixture(),
    browser = crypto.randomUUID();
  const record: AnalyticsMatch = {
    id: crypto.randomUUID(),
    game: "four-reversi",
    mode: "singles",
    startedAtMs: Date.now(),
    endedAtMs: null,
    status: "playing",
    cpuCount: 0,
    participants: [
      { playerId: crypto.randomUUID(), accountId: user.id, visitorId: browser, isTest: false },
    ],
  };
  const stub = env.GAME_ROOM.getByName("privacy-retired-analytics");
  await runInDurableObject(stub, async (_, ctx) => ctx.storage.kv.put("analytics-active", record));
  expect(await tombstone(user.id)).toBe(true);
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, ctx) =>
    expect(ctx.storage.kv.get<AnalyticsMatch>("analytics-active")!.participants[0]).toMatchObject({
      accountId: null,
      visitorId: null,
    }),
  );
});

test("受付後はセッション・編集・画像の再作成を拒否し、完了後の索引再送も旧名に戻らない", async () => {
  const user = await accountFixture(),
    player = crypto.randomUUID(),
    instance = crypto.randomUUID(),
    key = `avatars/${crypto.randomUUID()}.webp`,
    roomId = `privacy-fixture:${crypto.randomUUID()}`;
  // 索引だけのルーム番号を使い、他テストの実ルームと衝突させません。
  try {
    await env.OBJECT_STORAGE.put(key, "private");
    await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
    await env.APP_DB.prepare("INSERT INTO privacy_room_players VALUES (?,?,?,?,?)")
      .bind(user.id, roomId, instance, player, key)
      .run();
    expect(await tombstone(user.id)).toBe(true);
    expect((await request(`/avatars/${key.slice(8, -5)}`)).status).toBe(404);
    await env.APP_DB.prepare("UPDATE user SET name='復活する旧名',profileCompleted=1 WHERE id=?")
      .bind(user.id)
      .run();
    expect(
      await env.APP_DB.prepare("SELECT name,profileCompleted FROM user WHERE id=?")
        .bind(user.id)
        .first(),
    ).toEqual({ name: "退会したプレイヤー", profileCompleted: 0 });
    await env.APP_DB.prepare(
      "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        user.id,
        crypto.randomUUID(),
        Date.now() + 100000,
        Date.now(),
        Date.now(),
      )
      .run();
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM session WHERE userId=?").bind(user.id).first(),
    ).toBeNull();
    await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
    await processFixtureDeletion(user.id);
    await writeRoomIndex(env.APP_DB, {
      revision: 1,
      closed: false,
      retryAtMs: 0,
      metadata: {
        id: roomId,
        game: "four-reversi",
        mode: "singles",
        timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
        status: "waiting",
        hostName: "復活する旧名",
        humanCount: 1,
        cpuCount: 0,
        capacity: 4,
        openSeats: 3,
        updatedAtMs: Date.now(),
        instanceId: instance,
        hostPlayerId: player,
        hostAvatarUrl: `/api/avatars/${key.slice(8, -5)}`,
      },
    });
    expect(
      await env.APP_DB.prepare(
        "SELECT host_name,host_avatar_url,host_player_id FROM room_index WHERE room_id=?",
      )
        .bind(roomId)
        .first(),
    ).toEqual({ host_name: "退会したプレイヤー", host_avatar_url: null, host_player_id: null });
  } finally {
    await env.APP_DB.prepare("DELETE FROM room_index WHERE room_id=?").bind(roomId).run();
  }
});

test("閉鎖済みDOの索引保存待ちだけに残ったホスト名も保持した資格の対応から削除する", async () => {
  const room = await unusedRoomId();
  const user = await accountFixture();
  const player = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO privacy_room_players VALUES (?,?,?,?,NULL)")
    .bind(user.id, room, crypto.randomUUID(), player)
    .run();
  expect(await tombstone(user.id)).toBe(true);
  // 匿名化後の保存待ちを読むまで、実時間のAlarmが発火しないようにします。
  const now = Date.now() + 60 * 60 * 1000;
  fixTestTime(now);
  const stub = env.GAME_ROOM.getByName(room);
  await runInDurableObject(stub, async (_, ctx) => {
    expect(ctx.storage.kv.get("room")).toBeUndefined();
    ctx.storage.kv.put("room-index-pending", {
      revision: 1,
      closed: true,
      retryAtMs: now + 60_000,
      metadata: {
        id: room,
        game: "reversi",
        timeControl: { mainTimeMs: 300_000, byoyomiMs: 0 },
        status: "waiting",
        humanCount: 1,
        cpuCount: 0,
        capacity: 2,
        openSeats: 1,
        updatedAtMs: now,
        hostPlayerId: player,
        hostName: "閉鎖後の保存名",
        hostAvatarUrl: "/api/avatars/private",
      },
    } satisfies PendingRoomIndex);
  });
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, ctx) => {
    expect(ctx.storage.kv.get<PendingRoomIndex>("room-index-pending")).toMatchObject({
      closed: true,
      metadata: { hostName: "退会したプレイヤー", hostAvatarUrl: null },
    });
    expect(JSON.stringify([...ctx.storage.kv.list()])).not.toContain("閉鎖後の保存名");
  });
});
