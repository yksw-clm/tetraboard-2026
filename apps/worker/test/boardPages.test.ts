import { env } from "cloudflare:workers";
import { gameIds } from "@tetraboard/protocol/games";
import { afterEach, expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";
import { boardPostFixture, postPath, resetBoard } from "./boardFixtures";
import { assetFixture, visitMetaTag } from "./publicAssetFixtures";

afterEach(resetBoard);

async function expectPage(
  assets: ReturnType<typeof assetFixture>,
  path: string,
  status: number,
  bodyMarker = 'id="root"',
) {
  const headers = { "If-None-Match": '"fixture"' };
  const response = await assets.fetch(path, { headers });
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain('name="robots" content="noindex,follow"');
  expect(body).toContain(bodyMarker);

  const head = await assets.fetch(path, { method: "HEAD", headers });
  expect(head.status).toBe(status);
  expect([...head.headers]).toEqual([...response.headers]);
  expect(head.body).toBeNull();
}

test("掲示板は全6ゲームと末尾スラッシュを受け付け、対象外のゲームは404になる", async () => {
  const assets = assetFixture();
  for (const game of gameIds) await expectPage(assets, `/games/${game}/posts`, 200);
  await expectPage(assets, "/games/four-shogi/posts/", 200);
  await expectPage(assets, "/games/unknown/posts", 404, "ページが見つかりません");
});

test("掲示板のHTMLに訪問計測のメタタグを付け、ブラウザーに計測用Cookieを発行する", async () => {
  const response = await assetFixture().fetch("/games/four-shogi/posts", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(visitMetaTag);
  expect(response.headers.getSetCookie()).toContainEqual(
    expect.stringMatching(/^tetraboard-2026\.analytics=/),
  );
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test("詳細のHTMLは公開中と返信の残った枠を200、それ以外を404で返す", async () => {
  const { id: accountId } = await accountFixture();
  const live = boardPostFixture({ accountId });
  const empty = boardPostFixture({ accountId });
  const thread = boardPostFixture({ accountId });
  const reply = boardPostFixture({ accountId, parentId: thread.id });
  await env.APP_DB.batch([
    live.statement,
    empty.statement,
    thread.statement,
    reply.statement,
    env.APP_DB.prepare("UPDATE board_posts SET deleted_at_ms=?,body=NULL WHERE id IN (?,?)").bind(
      Date.now(),
      empty.id,
      thread.id,
    ),
  ]);
  const assets = assetFixture();
  await expectPage(assets, postPath(live.id), 200);
  await expectPage(assets, postPath(live.id) + "/", 200);
  await expectPage(assets, postPath(thread.id), 200);
  await expectPage(assets, postPath(empty.id), 404);
  await expectPage(assets, postPath(crypto.randomUUID()), 404);
  await expectPage(assets, postPath("not-a-uuid"), 404);
});

test("詳細がD1の読み取りに失敗しても再試行できるHTMLを503で返す", async () => {
  const assets = assetFixture({ APP_DB: undefined });
  await expectPage(assets, postPath(crypto.randomUUID()), 503);
});

test("詳細の読み取りが期限を超えたらHEADとGETを503で返す", async () => {
  const assets = assetFixture({
    APP_DB: {
      prepare: env.APP_DB.prepare.bind(env.APP_DB),
      batch: () => new Promise(() => {}),
    } as unknown as D1Database,
  });
  await expectPage(assets, postPath(crypto.randomUUID()), 503);
}, 7000);
