import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import {
  accountAvatarPresetId,
  accountProfileSchema,
  avatarPresets,
  avatarPresetUrl,
  createRoomContract,
  getRoomContract,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { requestDeletion } from "../src/privacy/deletion";
import { deleteUnusedAvatars } from "../src/accounts/accountRoutes";
import worker from "../src/worker";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
async function session(cookie: string) {
  const data = (await (
    await request("/account/session", { headers: { Cookie: cookie } })
  ).json()) as { user: unknown };
  return accountProfileSchema.parse(data.user);
}
async function select(
  user: Awaited<ReturnType<typeof accountFixture>>,
  id: string,
  action = "preset",
) {
  const form = new FormData();
  form.set("name", "プリセット利用者");
  form.set("username", user.username);
  form.set("avatarAction", action);
  form.set("avatarPresetId", id);
  const encoded = new Request(`${origin}/api/account/profile`, {
    method: "PATCH",
    headers: { Origin: origin, Cookie: user.cookie },
    body: form,
  });
  return request("/account/profile", {
    method: "PATCH",
    headers: encoded.headers,
    body: await encoded.arrayBuffer(),
  });
}
test("既存の画像未設定アカウントはDBを書き換えず固定アイコンを取得し、アップロードを優先する", async () => {
  const user = await accountFixture();
  const first = await session(user.cookie);
  expect(first.avatarPresetId).toBe(accountAvatarPresetId(user.id));
  expect(first.avatarUrl).toBe(avatarPresetUrl(first.avatarPresetId!));
  expect((await session(user.cookie)).avatarUrl).toBe(first.avatarUrl);
  expect(
    await env.APP_DB.prepare("SELECT avatarPresetId FROM user WHERE id=?")
      .bind(user.id)
      .first("avatarPresetId"),
  ).toBeNull();
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
  expect((await session(user.cookie)).avatarUrl).toBe(`/api/avatars/${key.slice(8, -5)}`);
});
test("ゲストはプリセットを保存でき、未知のID・画像アップロード・ID変更を拒否する", async () => {
  const created = await request("/account/guest", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": crypto.randomUUID(),
    },
    body: JSON.stringify({ name: "ゲスト" }),
  });
  expect(created.status).toBe(201);
  const original = accountProfileSchema.parse(await created.json());
  expect(original.avatarPresetId).toBeDefined();
  const cookie = created.headers
    .getSetCookie()
    .find((value) => value.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const save = (extra: object) =>
    request("/account/guest/name", {
      method: "PATCH",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "変更後", ...extra }),
    });
  const selected = avatarPresets.find((preset) => preset.id !== original.avatarPresetId)!;
  expect((await save({ avatarPresetId: selected.id })).status).toBe(200);
  expect((await session(cookie)).avatarUrl).toBe(avatarPresetUrl(selected.id));
  expect((await save({ avatarPresetId: "unknown" })).status).toBe(400);
  expect((await save({ username: "changed" })).status).toBe(403);
  expect((await save({ avatarAction: "replace" })).status).toBe(403);
  expect((await session(cookie)).username).toBe(original.username);
});
test("プリセット変更は新しい入室へ反映し、入室済みの席とR2参照を変えない", async () => {
  const user = await accountFixture();
  expect((await select(user, avatarPresets[0].id)).status).toBe(200);
  const created = await request("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ mode: "singles", quickPlay: false }),
  });
  expect(created.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await created.json());
  const snapshot = () =>
    request(`/rooms/${room.id}`).then(
      async (response) => getRoomContract.response.parse(await response.json()).room,
    );
  expect((await snapshot()).players[0]).toMatchObject({
    avatarUrl: avatarPresetUrl(avatarPresets[0].id),
  });
  expect((await select(user, avatarPresets[1].id)).status).toBe(200);
  expect((await snapshot()).players[0]).toMatchObject({
    avatarUrl: avatarPresetUrl(avatarPresets[0].id),
  });
  expect(
    await env.APP_DB.prepare("SELECT count(*) AS n FROM room_avatar_refs WHERE room_id=?")
      .bind(room.id)
      .first("n"),
  ).toBe(0);
  expect((await select(user, "bad")).status).toBe(400);
  expect((await select(user, avatarPresets[1].id, "remove")).status).toBe(200);
  expect((await session(user.cookie)).avatarPresetId).toBe(avatarPresets[1].id);
  await request(`/rooms/${room.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${membership.token}` },
  });
  const next = createRoomContract.response.parse(
    await (
      await request("/rooms", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ mode: "singles", quickPlay: false }),
      })
    ).json(),
  );
  expect(next.room.players[0]).toMatchObject({ avatarUrl: avatarPresetUrl(avatarPresets[1].id) });
});
test("アップロード削除は保存済みプリセットへ戻り、プリセットへの切替でも個人画像だけを削除する", async () => {
  const user = await accountFixture();
  await select(user, avatarPresets[3].id);
  for (const action of ["remove", "preset"]) {
    const key = `avatars/${crypto.randomUUID()}.webp`;
    await env.OBJECT_STORAGE.put(key, "uploaded");
    await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
    expect((await select(user, avatarPresets[3].id, action)).status).toBe(200);
    const current = await session(user.cookie);
    expect(current.avatarUrl).toBe(avatarPresetUrl(avatarPresets[3].id));
    expect(current.avatarPresetId).toBe(avatarPresets[3].id);
    const card = await request(
      `/player-profile?source=profile&profileId=${current.profileId}&game=four-reversi`,
    );
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ avatarUrl: current.avatarUrl });
    await deleteUnusedAvatars(env);
    expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT avatarKey FROM user WHERE id=?")
        .bind(user.id)
        .first("avatarKey"),
    ).toBeNull();
  }
});
test("共用画像は退会で消えず、プリセットの配信先とキャッシュを維持する", async () => {
  const user = await accountFixture();
  await select(user, avatarPresets[0].id);
  await requestDeletion(env, user.id, crypto.randomUUID());
  const calls: string[] = [];
  const assets = {
    async fetch(request: Request) {
      calls.push(new URL(request.url).pathname);
      return new Response("preset", { headers: { ETag: '"preset"' } });
    },
  } as Fetcher;
  for (const preset of avatarPresets) {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}${avatarPresetUrl(preset.id)}`),
      { ...env, ASSETS: assets },
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await response.text()).toBe("preset");
    expect(calls.at(-1)).toBe(`/assets/avatar-presets/v1/${preset.file}`);
  }
});
