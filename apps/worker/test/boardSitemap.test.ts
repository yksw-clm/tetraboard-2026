import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";
import { boardPostFixture, resetBoard } from "./boardFixtures";
import { assetFixture } from "./publicAssetFixtures";

afterEach(resetBoard);

const postedAtMs = Date.UTC(2026, 0, 1);
const sitemapPath = "/sitemap-posts.xml";
const postId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

async function seedPosts(accountId: string, count: number, text: string, thirdText = text) {
  await env.APP_DB.prepare(`WITH RECURSIVE numbers(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?
  )
  INSERT INTO board_posts(id,game_id,account_id,body,posted_at_ms,request_id,body_hash)
  SELECT printf('aaaaaaaa-aaaa-4aaa-8aaa-%012d',n),'shogi',?,
    CASE WHEN n=3 THEN ? ELSE ? END,?,CAST(n AS TEXT),'fixture' FROM numbers`)
    .bind(count, accountId, thirdText, text, postedAtMs)
    .run();
}

async function sitemapIds(assets = assetFixture()) {
  const response = await assets.fetch(sitemapPath);
  expect(response.status).toBe(200);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>[^<]*-(\d{12})<\/loc>/g)].map(([, suffix]) => Number(suffix));
}

test("候補が1,000件を超えても同じ投稿日時の投稿をID順にたどる", async () => {
  const { id: accountId } = await accountFixture();
  await seedPosts(accountId, 1002, "文".repeat(50), "❤️".repeat(49));
  // 最初のバッチの末尾にある n=3 は書記素の判定で落ちます。
  const expected = Array.from({ length: 1002 }, (_, i) => 1002 - i).filter((n) => n !== 3);
  expect(await sitemapIds()).toEqual(expected);
});

test("長い書記素を含む本文は1回数MBに収め、返信がある行には本文を含めない", async () => {
  const { id: accountId } = await accountFixture();
  const longText = `か${"\u3099".repeat(20_000)}${"文".repeat(49)}`;
  const count = 72;
  await seedPosts(accountId, count, longText, "短い投稿");
  await boardPostFixture({ accountId, parentId: postId(3), postedAtMs }).statement.run();

  const batches: number[] = [];
  const assets = assetFixture({
    APP_DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          async all() {
            const page = await env.APP_DB.prepare(sql)
              .bind(...params)
              .all<{ id: string; text: string }>();
            const replied = page.results.find(({ id }) => id === postId(3));
            if (replied) expect(replied.text).toBe("");
            batches.push(new TextEncoder().encode(JSON.stringify(page.results)).byteLength);
            return page;
          },
        }),
      }),
    } as unknown as D1Database,
  });
  expect(await sitemapIds(assets)).toEqual(Array.from({ length: count }, (_, i) => count - i));
  expect(batches.filter((bytes) => bytes > 2)).toHaveLength(2);
  expect(Math.max(...batches)).toBeLessThan(5 * 1024 * 1024);
});
