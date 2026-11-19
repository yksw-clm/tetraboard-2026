import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  feedbackDetailSchema,
  feedbackListSchema,
  feedbackInputSchema,
} from "@tetraboard/protocol";
import { validFeedbackImage } from "@tetraboard/context-community";
import { accountFixture, origin } from "./accountFixtures";
import {
  admin,
  input,
  post,
  getAdmin,
  webp,
  fetchWith,
  form,
  resetFeedback,
} from "./feedbackFixtures";

const cookieOf = (r: Response) => r.headers.get("Set-Cookie")!.split(";")[0]!;

beforeEach(resetFeedback);
afterEach(() => vi.restoreAllMocks());

test("終局評価は任意コメントと星1〜5・CPU戦/対人戦を保存し、投稿者はサーバー認証で区別する", async () => {
  const a = await admin();
  const user = await accountFixture();
  for (const [opponent, cookie, rating] of [
    ["cpu", "", 1],
    ["human", user.cookie, 5],
  ] as const) {
    const data = input({ kind: "opinion", body: "", expectation: "", steps: "", rating, opponent });
    const response = await post(data, cookie);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const detail = feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback;
    expect(detail).toMatchObject({
      rating,
      opponent,
      body: "",
      author: cookie ? "account" : "guest",
    });
    expect((await post(data, cookie)).status).toBe(201);
    expect((await post({ ...data, rating: 3 }, cookie)).status).toBe(409);
  }
  for (const query of [
    "?author=guest&opponent=cpu&rating=1",
    "?author=account&opponent=human&rating=5",
  ]) {
    expect(feedbackListSchema.parse(await (await getAdmin(query, a)).json()).feedback).toHaveLength(
      1,
    );
  }
  expect(
    feedbackListSchema.parse(await (await getAdmin("?author=guest&opponent=human", a)).json())
      .feedback,
  ).toHaveLength(0);
  for (const query of [
    "?rating=0",
    "?rating=6",
    "?rating=1.5",
    "?opponent=invalid",
    "?author=invalid",
  ]) {
    expect((await getAdmin(query, a)).status).toBe(400);
  }
});

test("星評価の範囲・整数・対戦区分・任意コメントの上限を検証し、従来投稿の本文必須を維持する", async () => {
  const base = {
    kind: "opinion",
    expectation: "",
    steps: "",
    body: "",
    rating: 3,
    opponent: "cpu",
  };
  for (const change of [
    { rating: 0 },
    { rating: 6 },
    { rating: 2.5 },
    { rating: "3" },
    { rating: undefined },
    { opponent: undefined },
    { opponent: "other" },
    { kind: "bug" },
    { game: "all" },
    { body: "a".repeat(2001) },
  ]) {
    expect((await post(input({ ...base, ...change }))).status).toBe(400);
  }
  expect((await post(input({ body: "" }))).status).toBe(400);
  expect((await post(input({ ...base, body: "よかったです" }))).status).toBe(201);
  const legacy = await post();
  const { id } = (await legacy.json()) as { id: string };
  const a = await admin();
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback,
  ).toMatchObject({ rating: null, opponent: null });
});

test("ゲスト受付は本文と画像を非公開に保存し、応答には受付番号だけを返す", async () => {
  const a = await admin();
  const r = await post(input(), "", webp());
  expect(r.status).toBe(201);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(r.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax");
  const receipt = (await r.json()) as { id: string };
  expect(Object.keys(receipt)).toEqual(["id"]);
  const detail = feedbackDetailSchema.parse(await (await getAdmin(`/${receipt.id}`, a)).json());
  expect(detail.feedback).toMatchObject({
    body: "画面の表示が崩れました",
    author: "guest",
    hasAttachment: true,
    status: "new",
  });
  const image = await getAdmin(`/${receipt.id}/attachment`, a);
  expect(image.status).toBe(200);
  expect(image.headers.get("Cache-Control")).toBe("no-store");
  expect(image.headers.get("Content-Type")).toBe("image/webp");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(webp());
  const row = await env.APP_DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(receipt.id)
    .first();
  expect(JSON.stringify(row)).not.toContain("192.0.2.1");
  expect(JSON.stringify(row)).not.toContain(cookieOf(r).split("=")[1]);
  expect((await fetchWith(`/api/feedback/${receipt.id}`)).status).toBe(404);
  expect((await fetchWith(`/api/avatars/${receipt.id}`)).status).toBe(404);
});

test("登録者・プロフィール未完了・内部投稿はサーバー認証で区別し、認証失敗をゲストにしない", async () => {
  const a = await admin();
  const incomplete = await accountFixture(false);
  const r = await post(input({ accountRequired: true }), incomplete.cookie);
  expect(r.status).toBe(201);
  const id = ((await r.json()) as { id: string }).id;
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${id}`, a)).json()).feedback.author,
  ).toBe("account");
  const internal = await post(input(), a.user.cookie, undefined, a.bindings);
  const iid = ((await internal.json()) as { id: string }).id;
  expect(
    feedbackDetailSchema.parse(await (await getAdmin(`/${iid}`, a)).json()).feedback.internal,
  ).toBe(true);
  expect((await post(input({ accountRequired: true }))).status).toBe(401);
  expect((await post(input(), "tetraboard-2026.session_token=invalid")).status).toBe(401);
  const broken = {
    ...env,
    APP_DB: {
      prepare: () => {
        throw new Error("database unavailable");
      },
    } as unknown as D1Database,
  };
  expect((await post(input(), incomplete.cookie, undefined, broken)).status).toBe(503);
});

test("同一内容の並行送信・再送は投稿と添付を一件にし、内容変更は409にする", async () => {
  const data = input();
  const browser = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
  const replies = await Promise.all([post(data, browser, webp()), post(data, browser, webp())]);
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  const ids = await Promise.all(replies.map(async (r) => ((await r.json()) as { id: string }).id));
  expect(ids[0]).toBe(ids[1]);
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>())?.n,
  ).toBe(1);
  expect((await env.OBJECT_STORAGE.list({ prefix: `feedback/${ids[0]}` })).objects).toHaveLength(1);
  expect((await post(data, browser, webp())).status).toBe(201);
  expect((await post({ ...data, body: "変更した内容" }, browser, webp())).status).toBe(409);
});

test("R2保存失敗は成功応答を返さず、再送で同じ予約を回復する", async () => {
  const data = input();
  const failure = {
    ...env,
    OBJECT_STORAGE: {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket,
  };
  const first = await post(data, "", webp(), failure);
  expect(first.status).toBe(503);
  const pending = await env.APP_DB.prepare("SELECT id, ready FROM feedback WHERE submission_id = ?")
    .bind(data.submissionId)
    .first<{ id: string; ready: number }>();
  expect(pending?.ready).toBe(0);
  const a = await admin();
  expect((await getAdmin(`/${pending!.id}`, a)).status).toBe(404);
  const retry = await post(data, cookieOf(first), webp());
  expect(retry.status).toBe(201);
  expect(((await retry.json()) as { id: string }).id).toBe(pending!.id);
});

test("D1受付失敗は投稿と画像を増やさず503にする", async () => {
  const bindings = {
    ...env,
    APP_DB: {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database,
  };
  const r = await post(input(), "", webp(), bindings);
  expect(r.status).toBe(503);
  expect(
    (await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>())?.n,
  ).toBe(0);
});

test("本文・任意項目・技術情報の上限、余分な情報、形式を検査する", async () => {
  for (const data of [
    input({ body: "  " }),
    input({ body: "あ".repeat(2001) }),
    input({ expectation: "a".repeat(501) }),
    input({ steps: "a".repeat(1001) }),
    input({ token: "secret" }),
    input({ technical: { url: "https://secret.test" } }),
    input({ kind: "request" }),
  ]) {
    expect((await post(data)).status).toBe(400);
  }
  expect(feedbackInputSchema.safeParse(input({ body: "😀".repeat(2000) })).success).toBe(true);
  const r = await post(
    input({ body: "あ".repeat(2000), expectation: "a".repeat(500), steps: "a".repeat(1000) }),
  );
  expect(r.status).toBe(201);
  const huge = new FormData();
  huge.set("input", "x".repeat(1024 * 1024 + 65537));
  expect(
    (await fetchWith("/api/feedback", { method: "POST", headers: { Origin: origin }, body: huge }))
      .status,
  ).toBe(413);
  expect(
    (
      await fetchWith("/api/feedback", {
        method: "POST",
        headers: { Origin: origin },
        body: "invalid",
      })
    ).status,
  ).toBe(400);
});

test("添付は静止WebP・長辺1600px・1MiBまでで、メタデータと偽装を拒否する", async () => {
  expect(validFeedbackImage(webp(1600, 900))).toBe(true);
  const metadata = new Uint8Array(40);
  metadata.set(webp());
  metadata.set(new TextEncoder().encode("EXIF"), 32);
  new DataView(metadata.buffer).setUint32(4, 32, true);
  for (const bytes of [
    webp(1601, 900),
    new Uint8Array(20),
    metadata,
    new Uint8Array(1024 * 1024 + 1),
  ]) {
    expect(validFeedbackImage(bytes)).toBe(false);
    expect((await post(input(), "", bytes)).status).not.toBe(201);
  }
  const animated = metadata.slice();
  animated.set(new TextEncoder().encode("ANIM"), 32);
  expect(validFeedbackImage(animated)).toBe(false);
  const wrong = form(input());
  wrong.set("attachment", new File([webp()], "capture.svg", { type: "image/svg+xml" }));
  expect(
    (await fetchWith("/api/feedback", { method: "POST", headers: { Origin: origin }, body: wrong }))
      .status,
  ).toBe(415);
});

test("ブラウザとアカウントの送信上限は並行送信でも超えず、既存送信の再送は許す", async () => {
  const user = await accountFixture();
  const data = input();
  const first = await post(data, user.cookie);
  const browser = cookieOf(first);
  expect(first.status).toBe(201);
  const replies = await Promise.all(
    Array.from({ length: 7 }, () => post(input(), `${user.cookie}; ${browser}`)),
  );
  expect(replies.filter((r) => r.status === 201)).toHaveLength(4);
  expect(replies.filter((r) => r.status === 429)).toHaveLength(3);
  expect((await post(data, `${user.cookie}; ${browser}`)).status).toBe(201);
  expect((await post(input(), user.cookie)).status).toBe(429);
});

test("IP上限を別ブラウザで回避できず、固定窓の10分・24時間境界で更新する", async () => {
  const now = Math.floor(Date.now() / 86400000) * 86400000 + 60000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let cookie = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
  for (let block = 0; block < 4; block++) {
    clock.mockReturnValue(now + block * 600000);
    for (let i = 0; i < 5; i++) expect((await post(input(), cookie)).status).toBe(201);
  }
  clock.mockReturnValue(now + 4 * 600000);
  expect((await post(input(), cookie)).status).toBe(429);
  clock.mockReturnValue(now + 86400000);
  expect((await post(input(), cookie)).status).toBe(201);
  await env.APP_DB.prepare("DELETE FROM feedback_limits").run();
  for (let i = 0; i < 30; i++) {
    cookie = `tetraboard-2026.feedback=${crypto.randomUUID()}`;
    expect((await post(input(), cookie)).status).toBe(201);
  }
  expect((await post(input(), `tetraboard-2026.feedback=${crypto.randomUUID()}`)).status).toBe(429);
});
