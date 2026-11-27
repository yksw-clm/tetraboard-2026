import { env } from "cloudflare:workers";
import { boardDetailSchema } from "@tetraboard/protocol/board";
import { gameIds } from "@tetraboard/protocol/games";
import { afterEach, expect, test, vi } from "vitest";
import { accountFixture } from "./accountFixtures";
import { boardPostFixture, boardRequest, postNumber, postPath, resetBoard } from "./boardFixtures";
import { assetFixture, visitMetaTag } from "./publicAssetFixtures";

afterEach(async () => {
  vi.restoreAllMocks();
  await resetBoard();
});

const origin = "https://tetraboard.net";
const sitemapPath = "/sitemap-posts.xml";
const indexableQuery = "?includeIndexable=1";
const now = Date.UTC(2026, 10, 27, 12);
const yesterday = Date.UTC(2026, 10, 26, 12);

function withdraw(accountId: string, time: number) {
  return env.APP_DB.prepare(
    "INSERT INTO deleted_accounts (id,requested_at_ms,receipt_hash) VALUES (?,?,?)",
  ).bind(accountId, time, crypto.randomUUID());
}

function removePost(id: string, time: number) {
  return env.APP_DB.prepare("UPDATE board_posts SET deleted_at_ms=?,body=NULL WHERE id=?").bind(
    time,
    id,
  );
}

function addLike(id: string, accountId: string, time: number) {
  return env.APP_DB.prepare("INSERT INTO board_likes VALUES (?,?,?)").bind(id, accountId, time);
}

function structuredData(html: string) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0]![1]!);
}

async function expectPage(
  assets: ReturnType<typeof assetFixture>,
  path: string,
  status: number,
  bodyMarker = 'id="root"',
  robotsHeader = "noindex, follow",
) {
  const headers = { "If-None-Match": '"fixture"' };
  const response = await assets.fetch(path, { headers });
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(response.headers.get("X-Robots-Tag")).toBe(robotsHeader);
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
  await expectPage(assets, postPath(await postNumber(live.id)), 200);
  await expectPage(assets, postPath(await postNumber(thread.id)), 200);
  await expectPage(assets, postPath(await postNumber(empty.id)), 404);
  const number = await postNumber(live.id);
  for (const invalid of [
    live.id,
    reply.id,
    0,
    -1,
    "1.5",
    "1e2",
    `0${number}`,
    `%30${number}`,
    "9007199254740992",
    "9007199254740991",
    `${number}%2F`,
    `${number}%3Fjunk`,
    `${number}%23junk`,
    `${number}%0A`,
  ]) {
    await expectPage(assets, postPath(invalid), 404);
  }
});

test("数字の投稿詳細は符号化と末尾スラッシュを正規化し、クエリを保持して308で転送する", async () => {
  const { id: accountId } = await accountFixture();
  const post = boardPostFixture({ accountId });
  await post.statement.run();
  const assets = assetFixture();
  const query = "?source=board&label=a%2Fb";
  const path = postPath(await postNumber(post.id));
  const encoded = path.replace(/\d/, (digit) => `%3${digit}`);
  for (const source of [encoded, `${encoded}/`, `${path}/`]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await assets.fetch(source + query, { method });
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(`${origin}${path}${query}`);
    }
  }
  await expectPage(assets, path + query, 200);
  await expectPage(assets, postPath(post.id) + "/" + query, 404);
});

test("詳細がD1の読み取りに失敗しても再試行できるHTMLを503で返す", async () => {
  const assets = assetFixture({ APP_DB: undefined });
  await expectPage(assets, postPath(1), 503);
});

test("詳細の読み取りが期限を超えたらHEADとGETを503で返す", async () => {
  const assets = assetFixture({
    APP_DB: {
      prepare: env.APP_DB.prepare.bind(env.APP_DB),
      batch: () => new Promise(() => {}),
    } as unknown as D1Database,
  });
  await expectPage(assets, postPath(1), 503);
}, 7000);

test("検索対象の投稿はヘッド、全文、リンク、公開中の返信をHTMLと構造化データに出す", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const author = await accountFixture();
  const departing = await accountFixture();
  const tournament = `${origin}/tournaments/1`;
  const room = `${origin}/rooms/12345?invite=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&watch=1`;
  const post = boardPostFixture({
    accountId: author.id,
    gameId: "shogi",
    postedAtMs: Date.UTC(2026, 10, 25, 16, 2, 3),
    text: `初手の案内\n</script> < "\n${tournament}`,
  });
  const reply = boardPostFixture({
    accountId: author.id,
    parentId: post.id,
    postedAtMs: yesterday,
    text: `返信の本文\n${room}`,
  });
  const removed = boardPostFixture({
    accountId: author.id,
    parentId: post.id,
    text: "削除された返信の本文",
  });
  const withdrawn = boardPostFixture({
    accountId: departing.id,
    parentId: post.id,
    text: "退会者の返信の本文",
  });
  await env.APP_DB.batch([
    post.statement,
    reply.statement,
    removed.statement,
    withdrawn.statement,
    removePost(removed.id, now),
    withdraw(departing.id, now),
    addLike(post.id, author.id, now),
    env.APP_DB.prepare("UPDATE user SET name=? WHERE id=?").bind('登録名 <"', author.id),
  ]);

  const path = postPath(await postNumber(post.id));
  const canonical = origin + path;
  const assets = assetFixture();
  const response = await assets.fetch(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Robots-Tag")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const html = await response.text();
  const head = html.match(/<head>([\s\S]*)<\/head>/)?.[1];
  expect(head).toContain('<meta name="robots" content="index,follow">');
  expect(head).not.toContain("noindex");
  expect(head).toMatch(
    /<title>初手の案内 &lt;\/script&gt; &lt; &quot; .*…｜将棋の掲示板 \| TetraBoard<\/title>/,
  );
  expect(head).toContain(
    `<meta name="description" content="初手の案内 &lt;/script&gt; &lt; &quot; ${tournament}">`,
  );
  expect(head).toContain(`<link rel="canonical" href="${canonical}">`);
  expect(head).toContain(`<meta property="og:image" content="${origin}/assets/ogp/shogi.png">`);
  expect(head?.match(/property="og:site_name"/g)).toHaveLength(1);
  expect(structuredData(head!)).toEqual({
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    url: canonical,
    author: { "@type": "Person", name: '登録名 <"' },
    datePublished: "2026-11-25T16:02:03.000Z",
    text: post.text,
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/LikeAction",
      userInteractionCount: 1,
    },
    comment: [
      {
        "@type": "Comment",
        author: { "@type": "Person", name: '登録名 <"' },
        datePublished: "2026-11-26T12:00:00.000Z",
        text: reply.text,
      },
    ],
  });
  expect(html).toContain('<div id="root" data-public-lobby="board-post"><main');
  expect(html).toContain('<time datetime="2026-11-25T16:02:03.000Z">2026/11/26 01:02:03</time>');
  expect(html).toContain("登録名 &lt;&quot;");
  expect(html).toContain(
    'class="whitespace-pre-wrap wrap-anywhere">初手の案内\n&lt;/script&gt; &lt; &quot;\n',
  );
  expect(html).toContain(`<a href="${tournament}">${tournament}</a>`);
  const roomHtml = room.replace("&", "&amp;");
  expect(html).toContain(`返信の本文\n<a href="${roomHtml}">${roomHtml}</a>`);
  for (const marker of [
    "♡ 1",
    'href="/games/shogi/posts"',
    'href="/games/shogi"',
    'href="/terms"',
    'href="/privacy"',
    "data-startup-status>投稿を読み込んでいます…",
    `data-startup-reload href="${canonical}">再読み込み`,
  ]) {
    expect(html).toContain(marker);
  }
  expect(html).not.toContain(removed.text);
  expect(html).not.toContain(withdrawn.text);
  const headResponse = await assets.fetch(path, { method: "HEAD" });
  expect(headResponse.status).toBe(200);
  expect([...headResponse.headers]).toEqual([...response.headers]);
  expect(headResponse.body).toBeNull();
});

test("退会で枠が残る投稿は元の本文・投稿者・いいねを出さず、返信は読める", async () => {
  const departing = await accountFixture();
  const remaining = await accountFixture();
  const post = boardPostFixture({
    accountId: departing.id,
    postedAtMs: yesterday,
    text: "消える親投稿の本文",
  });
  const reply = boardPostFixture({
    accountId: remaining.id,
    parentId: post.id,
    text: "残る返信の本文",
  });
  await env.APP_DB.batch([
    post.statement,
    reply.statement,
    addLike(post.id, remaining.id, now),
    withdraw(departing.id, now),
    env.APP_DB.prepare("UPDATE user SET name=? WHERE id=?").bind("退会した親投稿者", departing.id),
  ]);
  const response = await assetFixture().fetch(postPath(await postNumber(post.id)));
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
  const html = await response.text();
  expect(html).toContain('name="robots" content="noindex,follow"');
  expect(html).toContain("<title>削除された投稿｜リバーシの掲示板 | TetraBoard</title>");
  expect(html).toContain(
    'name="description" content="リバーシの掲示板の削除された投稿です。返信 1 件を読めます。"',
  );
  expect(html).toContain("<p>削除された投稿</p><time");
  expect(html).toContain("<span>返信 1</span>");
  expect(html).toContain(reply.text);
  for (const hidden of [post.text, "退会した親投稿者", "♡", "LikeAction", "application/ld+json"]) {
    expect(html).not.toContain(hidden);
  }
});

test("詳細APIはincludeIndexable=1を指定した場合だけindexableを返す", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const { id: accountId } = await accountFixture();
  const post = boardPostFixture({ accountId, postedAtMs: yesterday, text: "文".repeat(50) });
  await post.statement.run();
  const bindings: Env = { ...env, APP_ORIGIN: origin };
  const path = postPath(await postNumber(post.id));
  const legacySchema = boardDetailSchema.omit({ indexable: true });
  const legacy = await boardRequest(postPath(post.id), undefined, bindings);
  expect(legacy.status).toBe(200);
  const detail = legacySchema.parse(await legacy.json());
  const disabled = await boardRequest(path + "?includeIndexable=0", undefined, bindings);
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toEqual(detail);
  const enabled = await boardRequest(path + indexableQuery, undefined, bindings);
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toEqual({ ...detail, indexable: true });
});

test("API・HTML・サイトマップの検索判定は削除状態、投稿の経過時間、書記素の境界で一致する", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const { id: accountId } = await accountFixture();
  const seed = (text: string, postedAtMs = yesterday) =>
    boardPostFixture({ accountId, text, postedAtMs });
  const fifty = seed("👩‍👩‍👧‍👦か\u3099".repeat(25));
  const fortyNine = seed("👩‍👩‍👧‍👦".repeat(49));
  const fortyNinePlain = seed("あ".repeat(49));
  const nul = seed("\0" + "あ".repeat(49));
  const fresh = seed("あ".repeat(50), yesterday + 1);
  const answered = seed("短い投稿", yesterday - 1);
  const noLiveReplies = seed("削除した返信しかない投稿");
  const placeholder = seed("あ".repeat(50));
  const missing = seed("あ".repeat(50));
  const posts = [
    fifty,
    fortyNine,
    fortyNinePlain,
    nul,
    fresh,
    answered,
    noLiveReplies,
    placeholder,
    missing,
  ];
  const removedReply = boardPostFixture({ accountId, parentId: noLiveReplies.id });
  await env.APP_DB.batch([
    ...posts.map(({ statement }) => statement),
    boardPostFixture({ accountId, parentId: answered.id }).statement,
    boardPostFixture({ accountId, parentId: placeholder.id }).statement,
    removedReply.statement,
    removePost(removedReply.id, now),
    removePost(placeholder.id, now),
    removePost(missing.id, now),
  ]);
  const assets = assetFixture();
  const sitemap = await assets.fetch(sitemapPath);
  expect(sitemap.status).toBe(200);
  const xml = await sitemap.text();
  expect(xml.match(/<loc>/g)).toHaveLength(3);
  expect(xml.indexOf(postPath(await postNumber(fifty.id)))).toBeLessThan(
    xml.indexOf(postPath(await postNumber(answered.id))),
  );
  expect(xml.indexOf(postPath(await postNumber(nul.id)))).toBeLessThan(
    xml.indexOf(postPath(await postNumber(answered.id))),
  );
  for (const { id } of posts) {
    const indexable = id === fifty.id || id === answered.id || id === nul.id;
    const path = postPath(await postNumber(id));
    const status = id === missing.id ? 404 : 200;
    const api = await boardRequest(path + indexableQuery, undefined, {
      ...env,
      APP_ORIGIN: origin,
    });
    expect(api.status).toBe(status);
    if (api.ok) expect(boardDetailSchema.parse(await api.json()).indexable).toBe(indexable);
    const html = await assets.fetch(path);
    expect(html.status).toBe(status);
    expect(html.headers.get("X-Robots-Tag")).toBe(indexable ? null : "noindex, follow");
    expect(await html.text()).toContain(
      `name="robots" content="${indexable ? "index" : "noindex"},follow"`,
    );
    expect(xml.includes(`<loc>${origin}${path}</loc>`)).toBe(indexable);
  }
});

test("初期HTMLと構造化データの返信は古い順で最初の50件に限る", async () => {
  const { id: accountId } = await accountFixture();
  const post = boardPostFixture({ accountId, postedAtMs: yesterday });
  const replies = Array.from({ length: 51 }, (_, i) =>
    boardPostFixture({
      accountId,
      parentId: post.id,
      postedAtMs: yesterday + i + 1,
      text: `返信番号 ${String(i + 1).padStart(2, "0")}`,
    }),
  );
  await env.APP_DB.batch([post.statement, ...replies.map(({ statement }) => statement)]);
  const response = await assetFixture().fetch(postPath(await postNumber(post.id)));
  const html = await response.text();
  expect(structuredData(html).comment.map(({ text }: { text: string }) => text)).toEqual(
    replies.slice(0, 50).map(({ text }) => text),
  );
  const body = html.split("</head>")[1]!;
  expect([...body.matchAll(/返信番号 \d{2}/g)].map(([text]) => text)).toEqual(
    replies.slice(0, 50).map(({ text }) => text),
  );
  expect(body).toContain("返信 51");
});

test("サイトマップのlastmodは返信とその削除で進み、削除済み返信の投稿者の退会やいいねでは変わらない", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const { id: accountId } = await accountFixture();
  const removedReplyAuthor = await accountFixture();
  const departing = await accountFixture();
  const post = boardPostFixture({
    accountId,
    postedAtMs: Date.UTC(2026, 10, 21, 23),
    text: "長".repeat(50),
  });
  const reply = boardPostFixture({
    accountId: removedReplyAuthor.id,
    postedAtMs: Date.UTC(2026, 10, 22, 23),
    parentId: post.id,
  });
  const withdrawn = boardPostFixture({
    accountId: departing.id,
    postedAtMs: reply.postedAtMs,
    parentId: post.id,
  });
  const assets = assetFixture();
  const entry = (path: string, date: string) =>
    `<url><loc>${origin}${path}</loc><lastmod>2026-11-${date}</lastmod></url>`;
  const read = async () => {
    const response = await assets.fetch(sitemapPath, { headers: { "If-None-Match": '"fixture"' } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.text();
  };
  await post.statement.run();
  const path = postPath(await postNumber(post.id));
  expect(await read()).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entry(path, "21")}</urlset>`,
  );
  await env.APP_DB.batch([reply.statement, withdrawn.statement]);
  expect(await read()).toContain(entry(path, "22"));
  await removePost(reply.id, Date.UTC(2026, 10, 23, 23)).run();
  expect(await read()).toContain(entry(path, "23"));
  await withdraw(departing.id, Date.UTC(2026, 10, 24, 23)).run();
  const afterWithdrawal = await read();
  expect(afterWithdrawal).toContain(entry(path, "24"));
  await withdraw(removedReplyAuthor.id, Date.UTC(2026, 10, 25, 23)).run();
  expect(await read()).toBe(afterWithdrawal);
  await addLike(post.id, accountId, Date.UTC(2026, 10, 26, 23)).run();
  expect(await read()).toBe(afterWithdrawal);
  const head = await assets.fetch(sitemapPath, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
  expect(head.headers.get("Cache-Control")).toBe("no-store");
  expect(head.body).toBeNull();
  expect(assets.calls).toHaveLength(0);
  await removePost(post.id, now).run();
  expect(await read()).not.toContain("<loc>");
});

test("開発環境では条件を満たす投稿もnoindexで、サイトマップは404になる", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const { id: accountId } = await accountFixture();
  const post = boardPostFixture({ accountId, postedAtMs: yesterday, text: "文".repeat(50) });
  await post.statement.run();
  const APP_ORIGIN = "https://tetraboard-dev.chaossi-lab.workers.dev";
  const assets = assetFixture({ APP_ORIGIN });
  const path = postPath(await postNumber(post.id));
  const api = await boardRequest(path + indexableQuery, undefined, { ...env, APP_ORIGIN });
  expect(boardDetailSchema.parse(await api.json()).indexable).toBe(false);
  await expectPage(
    assets,
    path,
    200,
    `rel="canonical" href="${APP_ORIGIN}${path}"`,
    "noindex, nofollow",
  );
  await expectPage(assets, "/games/reversi/posts", 200, undefined, "noindex, nofollow");
  const response = await assets.fetch(sitemapPath);
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("ページが見つかりません");
  const head = await assets.fetch(sitemapPath, { method: "HEAD" });
  expect(head.status).toBe(404);
  expect(head.body).toBeNull();
});
