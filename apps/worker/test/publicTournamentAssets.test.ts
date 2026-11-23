import { env } from "cloudflare:workers";
import { tournamentSettingsSchema } from "@tetraboard/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { accountFixture } from "./accountFixtures";
import { assetFixture, files } from "./publicAssetFixtures";
import { useTournamentApiFixtures } from "./tournamentApiFixtures";

useTournamentApiFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "DELETE FROM tournament_scores WHERE tournament_key LIKE 'seo-tournament-%'",
    ),
    env.APP_DB.prepare(
      "DELETE FROM tournament_entries WHERE tournament_key LIKE 'seo-tournament-%'",
    ),
    env.APP_DB.prepare("DELETE FROM tournaments WHERE key LIKE 'seo-tournament-%'"),
  ]);
});

const tournamentNow = Date.UTC(2026, 10, 21, 16);
const hour = 3_600_000;
const tournamentListDescription =
  "TetraBoardで開催している大会の一覧です。開催中の大会、次回の大会、過去の大会の結果を見られます。";

async function seedTournament(
  id: number,
  name: string,
  startsAtMs: number,
  options: { published?: boolean; finalizedAtMs?: number; updatedAtMs?: number } = {},
) {
  const key = `seo-tournament-${id}`;
  await env.APP_DB.prepare(
    `INSERT INTO tournaments
     (key,public_id,name,description,rules_description,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      key,
      id,
      name,
      "大会の案内 <script>説明</script>",
      "今回のルール & 注意",
      startsAtMs,
      startsAtMs + 2 * hour,
      options.published === false ? 0 : 1,
      options.finalizedAtMs ?? null,
      startsAtMs,
      options.updatedAtMs ?? startsAtMs,
    )
    .run();
  return key;
}

function expectTournamentHead(
  body: string,
  title: string,
  description: string,
  canonical: string,
  imageName = "tetraboard",
  alt = "TetraBoardのロゴとボードゲームの盤面",
) {
  expect(body).toContain(`<title>${title}</title>`);
  expect(body).toContain(`<meta name="description" content="${description}">`);
  expect(body).toContain(`<link rel="canonical" href="${canonical}">`);
  const image = new URL(`/assets/ogp/${imageName}.png`, canonical).href;
  const tags = Array.from(
    body.matchAll(/<meta (property="og:[^"]+"|name="twitter:[^"]+") content="([^"]*)">/g),
    ([, attribute, content]) => [attribute, content],
  );
  expect(tags).toEqual([
    ['property="og:title"', title],
    ['property="og:description"', description],
    ['property="og:type"', "website"],
    ['property="og:url"', canonical],
    ['property="og:image"', image],
    ['property="og:image:width"', "1200"],
    ['property="og:image:height"', "630"],
    ['property="og:image:alt"', alt],
    ['property="og:site_name"', "TetraBoard"],
    ['name="twitter:card"', "summary_large_image"],
    ['name="twitter:title"', title],
    ['name="twitter:description"', description],
    ['name="twitter:image"', image],
    ['name="twitter:image:alt"', alt],
  ]);
}

function expectTournamentBreadcrumbs(
  body: string,
  origin: string,
  detail?: { id: number; name: string },
) {
  const scripts = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(body.match(/<head>([\s\S]*?)<\/head>/)?.[1]).toContain(scripts[0]![0]);
  const json = scripts[0]![1]!;
  expect(json).not.toContain("<");
  const items = [
    ["ホーム", `${origin}/`],
    ["大会一覧", `${origin}/tournaments`],
  ];
  if (detail) items.push([detail.name, `${origin}/tournaments/${detail.id}`]);
  expect(JSON.parse(json)).toEqual({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item,
    })),
  });
}

test("公開大会の全件を状態別に配信し、既存の7 URLと大会をサイトマップに載せる", async () => {
  vi.spyOn(Date, "now").mockReturnValue(tournamentNow);
  const assets = assetFixture();
  for (let id = 1; id <= 21; id++) {
    await seedTournament(id, `過去の大会${id}`, tournamentNow - 48 * hour, {
      finalizedAtMs: tournamentNow - 24 * hour,
      updatedAtMs: Date.UTC(2026, 10, 20),
    });
  }
  await seedTournament(22, "結果待ちの大会", tournamentNow - 3 * hour);
  await seedTournament(23, "開催中の大会", tournamentNow - hour);
  await seedTournament(24, "次回の大会の名前", tournamentNow + hour, {
    updatedAtMs: Date.UTC(2026, 10, 23),
  });
  await seedTournament(25, "非公開の大会", tournamentNow + hour, {
    published: false,
    updatedAtMs: Date.UTC(2026, 10, 24),
  });

  const list = await assets.fetch("/tournaments/?source=lobby");
  expect(list.status).toBe(200);
  expect(list.headers.get("X-Robots-Tag")).toBeNull();
  const body = await list.text();
  expectTournamentHead(
    body,
    "大会一覧｜TetraBoard",
    tournamentListDescription,
    "https://tetraboard.net/tournaments",
  );
  expectTournamentBreadcrumbs(body, "https://tetraboard.net");
  expect(body).toContain('<meta name="robots" content="index,follow">');
  expect(body).toContain('<div id="root" data-public-lobby="tournaments">');
  expect(body).toContain("<h1>大会一覧</h1>");
  expect(body).toMatch(
    /<h2>開催中<\/h2>[\s\S]*開催中の大会[\s\S]*結果待ちの大会[\s\S]*<h2>次回の大会<\/h2>[\s\S]*次回の大会の名前[\s\S]*<h2>過去の大会<\/h2>/,
  );
  for (let id = 1; id <= 24; id++) expect(body).toContain(`href="/tournaments/${id}"`);
  expect(body).not.toContain("非公開の大会");

  const sitemap = await assets.fetch("/sitemap.xml", { headers: { "If-None-Match": '"fixture"' } });
  expect(sitemap.status).toBe(200);
  expect(sitemap.headers.get("Content-Type")).toContain("application/xml");
  const xml = await sitemap.text();
  expect(xml).toContain(files["/sitemap.xml"]!.body.replace("</urlset>", ""));
  expect(xml).toContain(
    "<loc>https://tetraboard.net/tournaments</loc><lastmod>2026-11-23</lastmod>",
  );
  for (let id = 1; id <= 24; id++) {
    expect(xml).toMatch(
      new RegExp(
        `<loc>https://tetraboard.net/tournaments/${id}</loc><lastmod>2026-11-\\d{2}</lastmod>`,
      ),
    );
  }
  expect(xml).toContain(
    "<loc>https://tetraboard.net/tournaments/1</loc><lastmod>2026-11-20</lastmod>",
  );
  expect(xml).not.toContain("/tournaments/25");
  const head = await assets.fetch("/sitemap.xml", { method: "HEAD" });
  expect(head.status).toBe(sitemap.status);
  expect(await head.text()).toBe("");
});

test("大会と一覧のlastmodは行を更新しなくても開始・終了時刻に切り替わり、結果確定も反映する", async () => {
  const startsAtMs = Date.UTC(2026, 10, 21, 23);
  const endsAtMs = startsAtMs + 2 * hour;
  const finalizedAtMs = Date.UTC(2026, 10, 23);
  const now = vi.spyOn(Date, "now").mockReturnValue(startsAtMs - 1);
  const key = await seedTournament(1, "週末の大会", startsAtMs, {
    updatedAtMs: Date.UTC(2026, 10, 19),
  });
  const assets = assetFixture();

  async function expectLastmod(date: string) {
    const response = await assets.fetch("/sitemap.xml");
    expect(response.status).toBe(200);
    const xml = await response.text();
    for (const path of ["/tournaments", "/tournaments/1"])
      expect(xml).toContain(`<loc>https://tetraboard.net${path}</loc><lastmod>${date}</lastmod>`);
  }

  await expectLastmod("2026-11-19");
  now.mockReturnValue(startsAtMs);
  await expectLastmod("2026-11-21");
  now.mockReturnValue(endsAtMs);
  await expectLastmod("2026-11-22");
  now.mockReturnValue(finalizedAtMs);
  await env.APP_DB.prepare("UPDATE tournaments SET finalized_at_ms=? WHERE key=?")
    .bind(finalizedAtMs, key)
    .run();
  await expectLastmod("2026-11-23");
});

test("大会詳細は開催前の名前を公開せず、確定後は匿名化した順位表を配信する", async () => {
  vi.spyOn(Date, "now").mockReturnValue(tournamentNow);
  const upcomingName = '次回 <script>"大会"</script>';
  const upcoming = await seedTournament(1, upcomingName, tournamentNow + hour);
  await seedTournament(2, "今週の大会", tournamentNow - hour);
  await seedTournament(3, "集計中の大会", tournamentNow - 3 * hour);
  const finished = await seedTournament(4, "先週の大会", tournamentNow - 24 * hour, {
    finalizedAtMs: tournamentNow - hour,
  });
  const player = await accountFixture();
  await env.APP_DB.batch([
    env.APP_DB.prepare("UPDATE user SET name=? WHERE id=?").bind(
      "参加予定の人 <strong>",
      player.id,
    ),
    env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
      "upcoming-entry",
      upcoming,
      player.id,
      tournamentNow,
    ),
    env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
      "finished-entry",
      finished,
      player.id,
      tournamentNow,
    ),
    env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,NULL,?,1)").bind(
      "deleted-entry",
      finished,
      tournamentNow,
    ),
    env.APP_DB.prepare(
      "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,final_rank) VALUES(?,?,48,1,1),(?,?,21,1,2)",
    ).bind("finished-entry", finished, "deleted-entry", finished),
  ]);
  const assets = assetFixture();
  for (const [id, title, description, label] of [
    [
      1,
      "次回 &lt;script&gt;&quot;大会&quot;&lt;/script&gt;｜TetraBoard",
      "四人将棋の大会です。2026年11月22日に開催します。",
      "エントリー受付中",
    ],
    [
      2,
      "今週の大会｜TetraBoard",
      "四人将棋の大会です。2026年11月22日に開催し、0人がエントリーしています。",
      "開催中",
    ],
    [
      3,
      "集計中の大会｜TetraBoard",
      "四人将棋の大会です。2026年11月21日に開催し、0人がエントリーしています。",
      "結果発表待ち",
    ],
    [
      4,
      "先週の大会 結果｜TetraBoard",
      "四人将棋の大会の結果です。2026年11月21日に開催し、1人がエントリーしました。",
      "結果発表",
    ],
  ] as const) {
    const response = await assets.fetch(`/tournaments/${id}/?source=lobby`, {
      headers: { "If-None-Match": '"fixture"' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(response.headers.get("ETag")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expectTournamentHead(
      body,
      title,
      description,
      `https://tetraboard.net/tournaments/${id}`,
      "four-shogi",
      "四人将棋の盤面とTetraBoardのロゴ",
    );
    expect(body).toContain('content="index,follow"');
    expect(body).toContain(label);
    expect(body).toContain(`<dt>エントリー人数</dt><dd>${id === 1 || id === 4 ? 1 : 0}人</dd>`);
    expect(body).toContain('href="/tournaments"');
    expect(body).toContain('href="/terms"');
    expect(body).toContain('href="/privacy"');
    expect(body).toContain("大会の案内 &lt;script&gt;説明&lt;/script&gt;");
    expect(body).toContain("今回のルール &amp; 注意");
    expect(body).toContain("〈日本時間〉");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain(player.id);
    if (id === 1)
      expectTournamentBreadcrumbs(body, "https://tetraboard.net", { id, name: upcomingName });
    if (id === 4) {
      expect(body).toContain("<th");
      expect(body).toContain("勝ち点");
      expect(body).toContain("参加予定の人 &lt;strong&gt;");
      expect(body).toMatch(/退会したプレイヤー<\/td><td>1\.75/);
    } else {
      expect(body).not.toContain("<table");
      expect(body).not.toContain("参加予定の人");
    }
  }
  const head = await assets.fetch("/tournaments/4", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("X-Robots-Tag")).toBeNull();
  expect(await head.text()).toBe("");
});

test("開発の大会HTMLは検索除外と開発のcanonical・OGPを使い、サイトマップは静的なまま返す", async () => {
  vi.spyOn(Date, "now").mockReturnValue(tournamentNow);
  const key = await seedTournament(1, "開発の大会", tournamentNow + hour);
  const settings = tournamentSettingsSchema.parse({
    game: "four-reversi",
    mode: "singles",
    timeControl: { mainTimeMs: 60000, byoyomiMs: 10000 },
  });
  await env.APP_DB.prepare(
    "UPDATE tournaments SET rule_version=2,game=?,settings_json=? WHERE key=?",
  )
    .bind(settings.game, JSON.stringify(settings), key)
    .run();
  const origin = "https://tetraboard-dev.chaossi-lab.workers.dev";
  const assets = assetFixture({ APP_ORIGIN: origin });
  for (const path of ["/tournaments", "/tournaments/1"]) {
    const response = await assets.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    const body = await response.text();
    expect(body).toContain('content="noindex,follow"');
    expect(body).toContain("開発の大会");
    if (path === "/tournaments") {
      expectTournamentHead(body, "大会一覧｜TetraBoard", tournamentListDescription, origin + path);
      expectTournamentBreadcrumbs(body, origin);
    } else {
      expectTournamentHead(
        body,
        "開発の大会｜TetraBoard",
        "四人リバーシの大会です。2026年11月22日に開催します。",
        origin + path,
        "four-reversi",
        "四人リバーシの盤面とTetraBoardのロゴ",
      );
      expectTournamentBreadcrumbs(body, origin, { id: 1, name: "開発の大会" });
    }
  }
  expect(await (await assets.fetch("/sitemap.xml")).text()).toBe(files["/sitemap.xml"]!.body);
});

test("存在しない大会と非公開大会はnoindexのapp.htmlで404になる", async () => {
  await seedTournament(12, "非公開の大会", Date.now() + hour, { published: false });
  const assets = assetFixture();
  for (const path of ["/tournaments/1", "/tournaments/12/"]) {
    const response = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await response.text()).toBe(files["/app.html"]!.body);
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  }
});

test("D1の読み取り失敗時は大会のapp.htmlと静的サイトマップを返す", async () => {
  const assets = assetFixture({
    APP_DB: {
      prepare() {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database,
  });
  for (const path of ["/tournaments", "/tournaments/1"]) {
    const response = await assets.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    const body = await response.text();
    expect(body).toBe(files["/app.html"]!.body);
    expect(body).not.toContain("application/ld+json");
  }
  expect(await (await assets.fetch("/sitemap.xml")).text()).toBe(files["/sitemap.xml"]!.body);
});

test("D1が応答しない場合は1.5秒でnoindexのapp.htmlを返す", async () => {
  const assets = assetFixture({
    APP_DB: {
      prepare() {
        return { all: () => new Promise(() => {}) };
      },
    } as unknown as D1Database,
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const page = assets.fetch("/tournaments");
    await vi.advanceTimersByTimeAsync(1500);
    const response = await page;
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await response.text()).toBe(files["/app.html"]!.body);
  } finally {
    vi.useRealTimers();
  }
});
