import { boardPostIdSchema, scanBoardLinks, type BoardReply } from "@tetraboard/protocol/board";
import {
  boardPostMetadata,
  boardPostPath,
  renderDiscussionForumPostingJsonLd,
} from "@tetraboard/protocol/board-pages";
import { gameCatalog } from "@tetraboard/protocol/games";
import { openGraphTags } from "@tetraboard/protocol/room-sharing";
import { D1BoardReader } from "./adapters/community/boardReads";
import {
  dynamicAssetHeaders,
  escapeShareHtml,
  fetchUnconditionalAsset,
  readWithinDeadline,
} from "./htmlAssets";
import { sitemapEntry } from "./sitemap";

type BoardDetail = NonNullable<Awaited<ReturnType<D1BoardReader["detail"]>>>;

const exactTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function renderTime(ms: number): string {
  const date = new Date(ms);
  return `<time datetime="${escapeShareHtml(date.toISOString())}">${escapeShareHtml(exactTime.format(date))}</time>`;
}

function renderText(text: string, origin: string): string {
  let html = "";
  let end = 0;
  for (const occurrence of scanBoardLinks(text, origin)) {
    if (!occurrence.link) continue;
    const url = escapeShareHtml(occurrence.url);
    html += `${escapeShareHtml(text.slice(end, occurrence.start))}<a href="${url}">${url}</a>`;
    end = occurrence.end;
  }
  return `<p class="whitespace-pre-wrap wrap-anywhere">${html}${escapeShareHtml(text.slice(end))}</p>`;
}

function renderEntry(entry: BoardReply, origin: string): string {
  return `<header>${escapeShareHtml(entry.author.name)} ${renderTime(entry.postedAtMs)}</header>
    ${renderText(entry.text, origin)}`;
}

function renderDetail({ post, replies }: BoardDetail, origin: string, canonical: string): string {
  const game = gameCatalog[post.gameId];
  const replyCount = escapeShareHtml(String(post.replyCount));
  const article =
    post.status === "deleted"
      ? `<p>削除された投稿</p>${renderTime(post.postedAtMs)} <span>返信 ${replyCount}</span>`
      : `${renderEntry(post, origin)}<p>返信 ${replyCount}</p><p>♡ ${escapeShareHtml(String(post.likeCount))}</p>`;
  const replyList =
    replies.length > 0
      ? `<section aria-label="返信">${replies.map((reply) => `<article>${renderEntry(reply, origin)}</article>`).join("")}</section>`
      : "";
  return `<main class="mx-auto max-w-5xl p-6 text-ink">
    <nav aria-label="掲示板の移動">
      <a href="${escapeShareHtml(`/games/${post.gameId}/posts`)}">${escapeShareHtml(game.name)}の掲示板へ</a>
      <a href="${escapeShareHtml(game.lobbyPath)}">${escapeShareHtml(game.name)}のロビーへ</a>
    </nav>
    <h1>投稿の詳細</h1>
    <article>${article}</article>
    ${replyList}
    <p role="status" data-startup-status>投稿を読み込んでいます…</p>
    <a data-startup-reload href="${escapeShareHtml(canonical)}">再読み込み</a>
    <nav aria-label="規約とプライバシー">
      <a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a>
    </nav>
  </main>`;
}

function rewriteBoardHtml(response: Response, page: BoardDetail, origin: string): Response {
  const { post, replies, indexable } = page;
  const metadata = boardPostMetadata(origin, post);
  const { title, description, canonical } = metadata;
  const robots = indexable ? "index,follow" : "noindex,follow";
  const socialTags = openGraphTags(metadata, canonical, post.gameId)
    .map(({ kind, key, value }) => `<meta ${kind}="${key}" content="${escapeShareHtml(value)}">`)
    .join("");
  const tags =
    `<title>${escapeShareHtml(title)}</title>` +
    `<meta name="description" content="${escapeShareHtml(description)}">` +
    `<meta name="robots" content="${robots}">` +
    `<link rel="canonical" href="${escapeShareHtml(canonical)}">` +
    socialTags +
    (post.status === "published"
      ? renderDiscussionForumPostingJsonLd(canonical, post, replies)
      : "");
  return new HTMLRewriter()
    .on(
      "title, meta[name='description'], meta[name='robots'], link[rel='canonical'], meta[property^='og:'], meta[name^='twitter:']",
      {
        element(element) {
          element.remove();
        },
      },
    )
    .on("head", {
      element(element) {
        element.append(tags, { html: true });
      },
    })
    .on("#root", {
      element(element) {
        element.setAttribute("data-public-lobby", "board-post");
        element.setInnerContent(renderDetail(page, origin, canonical), { html: true });
      },
    })
    .transform(response);
}

async function readBoardDetail(env: Env | undefined, id: string) {
  if (!boardPostIdSchema.safeParse(id).success) return null;
  if (!env) return undefined;
  return readWithinDeadline(
    () =>
      new D1BoardReader(env.APP_DB).detail(id, null, env.APP_ORIGIN === "https://tetraboard.net"),
    "Published board post unavailable",
  );
}

export async function serveBoardHtml(request: Request, assets: Fetcher, env?: Env, id?: string) {
  const [asset, page] = await Promise.all([
    fetchUnconditionalAsset(request, assets, "/app.html"),
    id === undefined ? null : readBoardDetail(env, id),
  ]);
  const headers = dynamicAssetHeaders(asset);
  if (asset.ok && page?.indexable) headers.delete("X-Robots-Tag");
  else headers.set("X-Robots-Tag", "noindex, follow");
  let status = asset.status;
  if (asset.ok && id !== undefined && !page) status = page === null ? 404 : 503;
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status, headers });
  }
  const response = new Response(asset.body, { status, headers });
  return page && asset.ok && env ? rewriteBoardHtml(response, page, env.APP_ORIGIN) : response;
}

export async function serveBoardSitemap(request: Request, env: Env): Promise<Response> {
  const posts = await readWithinDeadline(
    () => new D1BoardReader(env.APP_DB).sitemapPosts(true),
    "Published board sitemap unavailable",
  );
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (!posts) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(request.method === "HEAD" ? null : "Service Unavailable", {
      status: 503,
      headers,
    });
  }
  headers.set("Content-Type", "application/xml; charset=utf-8");
  if (request.method === "HEAD") return new Response(null, { headers });
  const entries = posts.map(({ id, lastModifiedAtMs }) =>
    sitemapEntry(env.APP_ORIGIN, boardPostPath(id), lastModifiedAtMs),
  );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}</urlset>`,
    { headers },
  );
}
