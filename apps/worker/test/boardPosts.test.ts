import { env } from "cloudflare:workers";
import { accountProfileSchema } from "@tetraboard/protocol";
import { boardPostResultSchema, boardReplyResultSchema } from "@tetraboard/protocol/board";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { roomSharePath } from "@tetraboard/protocol/room-sharing";
import { afterEach, expect, test } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import {
  boardPath,
  boardPostFixture,
  boardRequest,
  likePath,
  openBoard,
  postPath,
  repliesPath,
  resetBoard,
  sendBoardPost,
  timeline,
} from "./boardFixtures";
import { fixTestTime } from "./fixedTimeFixture";

afterEach(resetBoard);

async function namedGuestHeaders() {
  const response = await boardRequest("/account/guest", {
    method: "POST",
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
    body: JSON.stringify({ name: "名前付きゲスト" }),
  });
  expect(response.status).toBe(201);
  expect(accountProfileSchema.parse(await response.json()).name).toBe("名前付きゲスト");
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("tetraboard-2026.guest="));
  expect(cookie).toBeDefined();
  return { Origin: origin, Cookie: cookie!.split(";")[0]! };
}

test("投稿・返信・いいねの両操作は登録済みで初回設定を終えたアカウントだけが使える", async () => {
  await openBoard();
  const incomplete = await accountFixture(false);
  const guest = await namedGuestHeaders();
  const account = await accountFixture();
  const parent = boardPostFixture({ accountId: account.id });
  await parent.statement.run();

  for (const [headers, status] of [
    [{ Origin: origin }, 401],
    [guest, 403],
    [incomplete.headers, 403],
  ] as const) {
    const responses = await Promise.all([
      sendBoardPost(boardPath, "本文", headers),
      sendBoardPost(repliesPath(parent.id), "返信", headers),
      boardRequest(likePath(parent.id), { method: "PUT", headers }),
      boardRequest(likePath(parent.id), { method: "DELETE", headers }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect((await timeline()).posts).toHaveLength(1);
});

test("書き込みの Origin を照合し、存在しないゲームは両方の経路で 404", async () => {
  const user = await accountFixture();
  const id = crypto.randomUUID();
  const responses = await Promise.all([
    sendBoardPost(boardPath, "本文", { ...user.headers, Origin: "https://example.com" }),
    sendBoardPost(repliesPath(id), "返信", { Cookie: user.cookie }),
    boardRequest(likePath(id), { method: "PUT", headers: { Cookie: user.cookie } }),
    boardRequest(likePath(id), { method: "DELETE", headers: { Cookie: user.cookie } }),
    boardRequest(postPath(id), { method: "DELETE", headers: { Cookie: user.cookie } }),
  ]);
  for (const response of responses) expect(response.status).toBe(403);
  const unknownGame = "/games/unknown/posts";
  expect((await boardRequest(unknownGame)).status).toBe(404);
  expect((await sendBoardPost(unknownGame, "本文", user.headers)).status).toBe(404);
  expect((await boardRequest(boardPath, undefined, env, "")).status).toBe(200);
});

test("本文を trim し、改行を保ち、見た目の文字数で 1 字から 1,000 字を受け付ける", async () => {
  const clock = fixTestTime();
  const now = Date.now();
  await openBoard();
  const user = await accountFixture();
  for (const text of ["  \n\t ", "🧑🏽‍💻".repeat(1001)])
    expect((await sendBoardPost(boardPath, text, user.headers)).status).toBe(400);
  expect(
    (
      await boardRequest(boardPath, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          text: "本文",
          matchId: crypto.randomUUID(),
          position: 0,
        }),
      })
    ).status,
  ).toBe(400);

  const texts = [" あ ", "🧑🏽‍💻".repeat(1000), "\n一行目\n二行目  "];
  for (const [i, text] of texts.entries()) {
    clock.mockReturnValue(now + i * 30_000);
    const response = await sendBoardPost(boardPath, text, user.headers);
    expect(response.status).toBe(200);
    const result = boardPostResultSchema.parse(await response.json());
    expect(result.post?.text).toBe(text.trim());
  }
  expect((await timeline()).posts.map((post) => post.status === "published" && post.text)).toEqual(
    texts.map((text) => text.trim()).reverse(),
  );
});

test("同一 Origin の公開棋譜・大会・ルーム共有だけを本文の URL として受け付ける", async () => {
  await openBoard();
  const user = await accountFixture();
  const match = `/matches/${crypto.randomUUID()}`;
  const invite = roomSharePath({ id: "12345", instanceId: crypto.randomUUID() });
  const urls = [match, `${match}?position=0`, "/tournaments/15", "/rooms/12345", invite];
  const text = urls.map((path) => origin + path).join("\n");
  expect((await sendBoardPost(boardPath, text, user.headers)).status).toBe(200);
  for (const link of [
    "https://example.com" + match,
    "https://example.com",
    "www.example",
    "example.com",
    origin + match + "/",
    origin + match + ".",
    origin + match + "#detail",
    origin + match + "?position=1&other=1",
    origin + match + "?position=-1",
    origin + match + "?position=9007199254740992",
    origin + "/tournaments/0",
    origin + "/tournaments/2?tab=rooms",
    origin + invite + "&watch=1",
    origin + "/rooms/12345?invite=invalid",
    origin + "/account" + match,
  ])
    expect(
      (await sendBoardPost(boardPath, `${origin}${match} ${link}`, user.headers)).status,
      link,
    ).toBe(400);
});

test("URLに日本語が続く本文を受け付け、後続の外部URLは拒否する", async () => {
  await openBoard();
  const user = await accountFixture();
  const text = `${origin}/tournaments/3です。${origin}/matches/${crypto.randomUUID()}。`;
  expect((await sendBoardPost(boardPath, text, user.headers)).status).toBe(200);
  expect(
    (await sendBoardPost(boardPath, text + "外部リンクはhttps://example.comです。", user.headers))
      .status,
  ).toBe(400);
});

test("受付は初期状態で停止し、アカウントの停止と受付中の状態を返す", async () => {
  const user = await accountFixture();
  expect((await timeline()).acceptingPosts).toBe(false);
  expect((await sendBoardPost(boardPath, "本文", user.headers)).status).toBe(403);
  await openBoard();
  await env.APP_DB.prepare("UPDATE board_senders SET stopped=1 WHERE account_id=?")
    .bind(user.id)
    .run();
  expect(await timeline("", user.cookie)).toMatchObject({
    acceptingPosts: true,
    postingStopped: true,
    availableAtMs: 0,
    posts: [],
  });
  expect((await sendBoardPost(boardPath, "本文", user.headers)).status).toBe(403);
  await env.APP_DB.prepare("UPDATE board_senders SET stopped=0 WHERE account_id=?")
    .bind(user.id)
    .run();
  expect((await sendBoardPost(boardPath, "本文", user.headers)).status).toBe(200);
});

test("投稿と返信で間隔を共有し、30秒ちょうどで返信を受付け、返信への返信は拒否する", async () => {
  const clock = fixTestTime();
  const now = Date.now();
  await openBoard();
  const user = await accountFixture();
  const first = await sendBoardPost(boardPath, "投稿", user.headers);
  expect(first.status).toBe(200);
  const { post } = boardPostResultSchema.parse(await first.json());
  const path = repliesPath(post!.id);
  for (const offset of [0, 29_999]) {
    clock.mockReturnValue(now + offset);
    const response = await sendBoardPost(path, "返信", user.headers);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ availableAtMs: now + 30_000 });
  }
  clock.mockReturnValue(now + 30_000);
  const response = await sendBoardPost(path, "返信", user.headers);
  expect(response.status).toBe(200);
  const { reply } = boardReplyResultSchema.parse(await response.json());
  expect(
    await env.APP_DB.prepare("SELECT game_id,parent_id FROM board_posts WHERE id=?")
      .bind(reply!.id)
      .first(),
  ).toEqual({ game_id: "reversi", parent_id: post!.id });
  const another = await accountFixture();
  expect((await sendBoardPost(repliesPath(reply!.id), "返信", another.headers)).status).toBe(404);
  expect(
    (await sendBoardPost(repliesPath(crypto.randomUUID()), "返信", another.headers)).status,
  ).toBe(404);
});

test("並行する別の投稿は1件だけ受け付け、同じ要求の再送は重複を保存しない", async () => {
  fixTestTime();
  await openBoard();
  const user = await accountFixture();
  const intent = [crypto.randomUUID(), crypto.randomUUID()] as const;
  const results = await Promise.all(
    intent.map((id) => sendBoardPost(boardPath, "同じ本文", user.headers, id)),
  );
  expect(results.map((response) => response.status).sort()).toEqual([200, 429]);
  const accepted = results.findIndex((r) => r.status === 200);
  const requestId = intent[accepted]!;
  const initial = boardPostResultSchema.parse(await results[accepted]!.json());
  const resent = await sendBoardPost(boardPath, " 同じ本文 ", user.headers, requestId);
  expect(resent.status).toBe(200);
  expect(boardPostResultSchema.parse(await resent.json())).toEqual(initial);
  expect((await timeline()).posts).toHaveLength(1);
  expect((await sendBoardPost(boardPath, "変更", user.headers, requestId)).status).toBe(409);
  expect(
    (await sendBoardPost("/games/shogi/posts", "同じ本文", user.headers, requestId)).status,
  ).toBe(409);
  expect(
    (await sendBoardPost(repliesPath(initial.post!.id), "同じ本文", user.headers, requestId))
      .status,
  ).toBe(409);

  expect(
    (await boardRequest(postPath(initial.post!.id), { method: "DELETE", headers: user.headers }))
      .status,
  ).toBe(204);
  const removedReplay = await sendBoardPost(boardPath, "同じ本文", user.headers, requestId);
  expect(removedReplay.status).toBe(200);
  expect(boardPostResultSchema.parse(await removedReplay.json())).toEqual({
    post: null,
    availableAtMs: initial.availableAtMs,
  });
  expect(
    await env.APP_DB.prepare("SELECT body FROM board_posts WHERE id=?")
      .bind(initial.post!.id)
      .first(),
  ).toEqual({ body: null });
});
