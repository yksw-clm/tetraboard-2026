import { symmetricEncrypt } from "better-auth/crypto";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { accountIdentity } from "../src/adapters/account/auth";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { authSecret, unsealToken } from "../src/adapters/account/authTokens";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { processFixtureDeletion, tombstone, request } from "./privacyFixtures";

afterEach(() => vi.restoreAllMocks());

test("R2失敗は処理中を維持して再試行し、完了時は認証・同意・画像を削除して再登録を新規とする", async () => {
  const user = await accountFixture();
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, "private image");
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
  const receipt = crypto.randomUUID() + crypto.randomUUID();
  expect(await requestDeletion(env, user.id, receipt)).toBe(true);
  // 他テストの部屋に依存せず、この受付の画像段階を検証します。
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  const failure = {
    ...env,
    OBJECT_STORAGE: {
      delete: async () => {
        throw new Error("unavailable");
      },
    } as unknown as R2Bucket,
  };
  await processFixtureDeletion(user.id, failure);
  expect(
    await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ completed_at_ms: null });
  await processFixtureDeletion(user.id);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
  for (const [table, column] of [
    ["user", "id"],
    ["session", "userId"],
    ["legal_consents", "account_id"],
  ])
    expect(
      await env.APP_DB.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).bind(user.id).first(),
    ).toBeNull();
  expect(
    (await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first<{ completed_at_ms: number }>())!.completed_at_ms,
  ).toBeGreaterThan(0);
  const fresh = await accountFixture();
  expect(fresh.id).not.toBe(user.id);
  expect(
    await accountIdentity(new Request(origin, { headers: { Cookie: fresh.cookie } }), env),
  ).not.toBeNull();
});

test("OAuthトークンの平文を復号結果として受理しない", async () => {
  await expect(unsealToken(env, "plaintext-provider-token")).rejects.toThrow();
});

test("暗号化されたOAuthトークンを復号し、解除の失敗を成功にせず再試行する", async () => {
  const user = await accountFixture(),
    token = "private-provider-token";
  const sealed = await symmetricEncrypt({ key: authSecret(env), data: token });
  await env.APP_DB.prepare(
    "INSERT INTO account(id,accountId,providerId,userId,accessToken,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      crypto.randomUUID(),
      "google",
      user.id,
      sealed,
      Date.now(),
      Date.now(),
    )
    .run();
  expect(sealed).not.toBe(token);
  expect(await unsealToken(env, sealed)).toBe(token);
  expect(await tombstone(user.id)).toBe(true);
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init!.body)).toContain(token);
    return Response.json({ error: "invalid_client" }, { status: 400 });
  });
  await processFixtureDeletion(user.id);
  expect(
    await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ completed_at_ms: null });
  mock.mockImplementation(async () => Response.json({ error: "invalid_token" }, { status: 400 }));
  await processFixtureDeletion(user.id);
  expect(
    (await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first<{ completed_at_ms: number }>())!.completed_at_ms,
  ).toBeGreaterThan(0);
});

test("本人の新旧フィードバック・画像・編集履歴・投稿制限を消し、他者の投稿を残す", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const post = async (cookie: string) => {
    const body = new FormData();
    body.set(
      "input",
      JSON.stringify({
        submissionId: crypto.randomUUID(),
        kind: "bug",
        game: "four-reversi",
        body: "本人だけが提出した原文",
        expectation: "正常表示",
        steps: "画面を開く",
        technical: null,
      }),
    );
    const response = await request("/feedback", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const ids = [await post(user.cookie), await post(user.cookie)],
    others = await post(other.cookie);
  await env.APP_DB.prepare("UPDATE feedback SET account_id=NULL WHERE id=?").bind(ids[0]).run();
  const key = `feedback/${ids[0]}.webp`;
  await env.OBJECT_STORAGE.put(key, "private feedback");
  await env.APP_DB.prepare("UPDATE feedback SET attachment_key=? WHERE id=?")
    .bind(key, ids[0])
    .run();
  await env.APP_DB.prepare("INSERT INTO feedback_history VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), ids[0], other.id, "編集者", Date.now(), '{"before":"原文"}')
    .run();
  expect(await tombstone(user.id)).toBe(true);
  for (const id of ids)
    expect(
      await env.APP_DB.prepare("SELECT deleted FROM feedback WHERE id=?").bind(id).first(),
    ).toEqual({ deleted: 1 });
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  await processFixtureDeletion(user.id);
  for (const id of ids) {
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM feedback WHERE id=?").bind(id).first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM feedback_history WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  }
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM feedback WHERE id=?").bind(others).first(),
  ).not.toBeNull();
});

test("退会受付中に到着する新しいプロフィール画像も発見し、R2失敗を再試行する", async () => {
  const user = await accountFixture(),
    bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 24, true);
  view.setUint32(16, 12, true);
  bytes[20] = 0x2f;
  view.setUint32(21, 255 | (255 << 14), true);
  let uploaded = "";
  const original = env.OBJECT_STORAGE;
  const storage = {
    put: async (key: string, value: Uint8Array, options: R2PutOptions) => {
      uploaded = key;
      expect(await tombstone(user.id)).toBe(true);
      await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
      await processFixtureDeletion(user.id);
      expect(
        await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
          .bind(user.id)
          .first(),
      ).toEqual({ completed_at_ms: null });
      return original.put(key, value, options);
    },
    delete: async () => {
      throw new Error("Unavailable");
    },
  } as unknown as R2Bucket;
  const body = new FormData();
  body.set("name", "本人");
  body.set("username", user.username);
  body.set("avatarAction", "replace");
  body.set("avatar", new File([bytes], "avatar.webp", { type: "image/webp" }));
  const response = await worker.fetch(
    new Request(`${origin}/api/account/profile`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: user.cookie },
      body,
    }),
    { ...env, OBJECT_STORAGE: storage },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(503);
  expect(uploaded).toBeTruthy();
  expect(await original.get(uploaded)).not.toBeNull();
  await processFixtureDeletion(user.id);
  expect(await original.get(uploaded)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM privacy_avatar_uploads WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();
});
