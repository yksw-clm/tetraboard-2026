import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { accountProfileSchema, createRoomContract } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { requestDeletion } from "../src/privacy/deletion";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
async function save(
  user: Awaited<ReturnType<typeof accountFixture>>,
  details: Record<string, string> = {},
  setup = false,
) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: "更新した名前",
    username: user.username,
    avatarAction: "keep",
    consentVersion: legalVersion,
    ...details,
  }))
    data.set(key, value);
  const encoded = new Request(`${origin}/api/account/${setup ? "setup" : "profile"}`, {
    method: setup ? "POST" : "PATCH",
    headers: { Cookie: user.cookie, Origin: origin },
    body: data,
  });
  return exports.default.fetch(
    new AcceptedGameRequest(encoded.url, {
      method: encoded.method,
      headers: encoded.headers,
      body: await encoded.arrayBuffer(),
    }),
  );
}
async function session(cookie: string) {
  const response = await request("/account/session", { headers: { Cookie: cookie } });
  return accountProfileSchema.parse(((await response.json()) as { user: unknown }).user);
}

test("初回設定で任意項目を保存し、旧フォームでは保持、明示的な空欄で削除する", async () => {
  const user = await accountFixture(false);
  const details = {
    profileMessage: " 👨‍👩‍👧‍👦と遊ぼう ",
    favoriteGames: '["gomoku","four-shogi","reversi"]',
  };
  const created = await save(user, details, true);
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({
    profileMessage: "👨‍👩‍👧‍👦と遊ぼう",
    favoriteGames: ["four-shogi", "reversi", "gomoku"],
  });
  expect((await save(user)).status).toBe(200);
  expect(await session(user.cookie)).toMatchObject({
    profileMessage: "👨‍👩‍👧‍👦と遊ぼう",
    favoriteGames: ["four-shogi", "reversi", "gomoku"],
  });
  expect((await save(user, { profileMessage: "", favoriteGames: "[]" })).status).toBe(200);
  expect(await session(user.cookie)).toMatchObject({ profileMessage: "", favoriteGames: [] });
});

test("文字数・改行・ゲームの境界を検証し、不正入力では他の変更も保存しない", async () => {
  const user = await accountFixture();
  const before = await session(user.cookie);
  const invalidDetails: Record<string, string>[] = [
    { profileMessage: "あ".repeat(31) },
    { profileMessage: "挨拶\n改行" },
    { profileMessage: "\r挨拶" },
    { profileMessage: "挨拶\u2028改行" },
    { favoriteGames: '["unknown"]' },
    { favoriteGames: '["shogi","shogi"]' },
    { favoriteGames: '["shogi","reversi","gomoku","four-shogi"]' },
    { favoriteGames: '"shogi"' },
    { favoriteGames: "broken" },
  ];
  for (const details of invalidDetails) {
    expect((await save(user, { ...details, avatarAction: "remove" })).status).toBe(400);
  }
  expect(await session(user.cookie)).toEqual(before);
  const saved = await save(user, { profileMessage: "👨‍👩‍👧‍👦".repeat(30), favoriteGames: "[]" });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ profileMessage: "👨‍👩‍👧‍👦".repeat(30), favoriteGames: [] });
});

test("ゲストからの追加項目の設定を拒否し、名前も更新しない", async () => {
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
  const cookie = created.headers
    .getSetCookie()
    .find((v) => v.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  for (const details of [{ profileMessage: "よろしく" }, { favoriteGames: ["shogi"] }]) {
    expect(
      (
        await request("/account/guest/name", {
          method: "PATCH",
          headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "書換禁止", ...details }),
        })
      ).status,
    ).toBe(403);
  }
  expect(await session(cookie)).toMatchObject({ name: "ゲスト" });
  expect(
    (
      await request("/account/guest", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ゲスト", profileMessage: "設定禁止" }),
      })
    ).status,
  ).toBe(403);
  const own = await session(cookie);
  const card = await request(
    `/player-profile?source=profile&profileId=${own.profileId}&game=four-reversi&includeDetails=1`,
  );
  expect(card.status).toBe(200);
  expect(await card.json()).not.toHaveProperty("profileMessage");
});

test("公開項目は要求時だけ返し、在室中も現在値を参照し、退会後は公開しない", async () => {
  const user = await accountFixture();
  const own = await session(user.cookie);
  const target = `source=profile&profileId=${own.profileId}&game=four-reversi`;
  const read = async (query = target, details = true) =>
    request(`/player-profile?${query}${details ? "&includeDetails=1" : ""}`);
  const old = await (await read(target, false)).json();
  expect(old).not.toHaveProperty("profileMessage");
  expect(old).not.toHaveProperty("favoriteGames");
  expect(await (await read()).json()).toMatchObject({ profileMessage: "", favoriteGames: [] });
  const created = await request("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ mode: "singles", quickPlay: false }),
  });
  expect(created.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await created.json());
  const roomTarget = `source=room&roomId=${room.id}&instanceId=${room.instanceId}&playerId=${room.players[0]!.id}&game=four-reversi`;
  expect(
    (await save(user, { profileMessage: "対局しよう", favoriteGames: '["shogi"]' })).status,
  ).toBe(200);
  for (const query of [target, roomTarget]) {
    const result = await read(query);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      profileMessage: "対局しよう",
      favoriteGames: ["shogi"],
    });
  }
  await request(`/rooms/${room.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${membership.token}` },
  });
  await requestDeletion(env, user.id, crypto.randomUUID());
  expect((await read()).status).toBe(404);
  expect((await request(`/player-profile?${target}&includeDetails=0`)).status).toBe(400);
});
