import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker";
import { fixtureRecord } from "./matchFixtures";
import { accountFixture } from "./accountFixtures";
import { writeMatch } from "../src/flows/matchSave/snapshot";
const extra = bindings as typeof bindings & {
  MATCH_SHARE_TEST_DB: D1Database;
};
const db = extra.MATCH_SHARE_TEST_DB;
const ids: string[] = [],
  users: string[] = [];
const assets = {
  async fetch(_request: Request) {
    return new Response(
      '<html><head><title>Old</title><meta property="og:image" content="old"><meta name="twitter:card" content="summary"></head><body>app</body></html>',
      {
        headers: { "Content-Type": "text/html", ETag: '"old"' },
      },
    );
  },
} as Fetcher;
const env = { ...bindings, APP_DB: db, ASSETS: assets };
const request = (path: string, init?: RequestInit, override: Partial<Env> = {}) =>
  worker.fetch(
    new Request(`http://localhost:5173${path}`, init),
    { ...env, ...override },
    {} as ExecutionContext,
  );
beforeAll(async () =>
  applyD1Migrations(
    db,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  ),
);
afterEach(async () => {
  for (const id of ids.splice(0)) {
    for (const [table, key] of [
      ["account_match_history", "match_id"],
      ["match_event_chunks", "match_id"],
      ["matches", "id"],
    ])
      await db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).bind(id).run();
  }
  for (const id of users.splice(0)) {
    await db.prepare("DELETE FROM session WHERE userId=?").bind(id).run();
    await db.prepare("DELETE FROM user WHERE id=?").bind(id).run();
  }
});
async function saved() {
  const user = await accountFixture(true, crypto.randomUUID(), db);
  users.push(user.id);
  const record = fixtureRecord(user.id, 1);
  ids.push(record.id);
  await writeMatch(db, record);
  return { record, user };
}
test("公開棋譜の初期HTMLは対局別カードを通常UAとクローラーへ返し、HEADと条件付き取得を扱う", async () => {
  const { record } = await saved();
  for (const ua of ["Mozilla/5.0", "Twitterbot"]) {
    const response = await request(`/matches/${record.id}`, {
      headers: { "User-Agent": ua, "If-None-Match": '"old"' },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("四人リバーシの対局結果 | TetraBoard");
    expect(html).toContain("http://localhost:5173/assets/ogp/four-reversi.png");
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("ETag")).toBeNull();
    expect(html).not.toContain(record.instanceId);
    expect(html).not.toContain("accountId");
  }
  const head = await request(`/matches/${record.id}`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});
test("改名によらず同じゲームの固定画像を使い、画像生成APIを公開しない", async () => {
  const { record, user } = await saved();
  await db.prepare("UPDATE user SET name=? WHERE id=?").bind('新しい名前<&"', user.id).run();
  const detail = (await (await request(`/api/matches/${record.id}`)).json()) as {
    match: { participants: { name: string }[] };
  };
  expect(detail.match.participants.some((player) => player.name === '新しい名前<&"')).toBe(true);
  const html = await (await request(`/matches/${record.id}`)).text();
  expect(html).toContain("/assets/ogp/four-reversi.png");
  expect(html).not.toContain("新しい名前");
  expect((await request(`/api/matches/${record.id}/ogp.png`)).status).toBe(404);
});
test("未保存と取得障害でも棋譜HTMLは共通カードで復帰できる", async () => {
  const missing = crypto.randomUUID();
  expect(await (await request(`/matches/${missing}`)).text()).toContain(
    "/assets/ogp/tetraboard.png",
  );
  const { record } = await saved();
  const broken = {} as D1Database;
  expect(
    await (await request(`/matches/${record.id}`, undefined, { APP_DB: broken })).text(),
  ).toContain("/assets/ogp/tetraboard.png");
});

test("固定OGPの初期HTMLは本体の1照会だけで返し、チャンクとプロフィールの障害を待たない", async () => {
  const { record } = await saved();
  const queries: string[] = [];
  const metadataDb = {
    prepare(sql: string) {
      queries.push(sql);
      if (sql !== "SELECT game, record_json FROM matches WHERE id = ?")
        throw new Error("Chunks and profiles unavailable");
      return db.prepare(sql);
    },
  } as D1Database;
  const response = await request(`/matches/${record.id}`, undefined, { APP_DB: metadataDb });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("/assets/ogp/four-reversi.png");
  expect(queries).toEqual(["SELECT game, record_json FROM matches WHERE id = ?"]);
  expect(
    (await request(`/api/matches/${record.id}`, undefined, { APP_DB: metadataDb })).status,
  ).toBe(503);
});

test("チャンクの欠落は棋譜APIで検出し、固定OGPは検証済みの本体から返す", async () => {
  const { record } = await saved();
  await db.prepare("DELETE FROM match_event_chunks WHERE match_id=?").bind(record.id).run();
  const html = await (await request(`/matches/${record.id}`)).text();
  expect(html).toContain("/assets/ogp/four-reversi.png");
  expect((await request(`/api/matches/${record.id}`)).status).toBe(503);
});

test("保存本体の壊れたJSON・形式・ゲーム不一致は固定OGPに採用しない", async () => {
  const { record } = await saved();
  for (const json of ["{", "{}", JSON.stringify({ ...record, settings: { game: "gomoku" } })]) {
    await db.prepare("UPDATE matches SET record_json=? WHERE id=?").bind(json, record.id).run();
    const response = await request(`/matches/${record.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/assets/ogp/tetraboard.png");
  }
});

test.each(["GET", "HEAD"])(
  "%sのメタ情報取得は1500msで打ち切り、共通カードでアプリを配信する",
  async (method) => {
    vi.useFakeTimers();
    try {
      let rejectRead!: (error: Error) => void;
      const delayed = {
        prepare() {
          return {
            bind() {
              return {
                first: () =>
                  new Promise((_, reject) => {
                    rejectRead = reject;
                  }),
              };
            },
          };
        },
      } as unknown as D1Database;
      let settled = false;
      const pending = request(`/matches/${crypto.randomUUID()}`, { method }, { APP_DB: delayed });
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
      const html = await response.text();
      if (method === "HEAD") expect(html).toBe("");
      else {
        expect(html).toContain("/assets/ogp/tetraboard.png");
        expect(html).toContain("<body>app</body>");
      }
      // 打ち切り後の遅延した失敗も未処理の拒否にしません。
      rejectRead(new Error("Late D1 failure"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
