import {
  formatTournamentPoints,
  gameCatalog,
  getTournamentSettings,
  tournamentRulesSummary,
  tournamentSettingsDescription,
  tournamentStatusLabels,
  type GameId,
  type TournamentPublic,
  type TournamentSettings,
  type TournamentStage,
} from "@tetraboard/protocol";
import {
  tournamentDate,
  tournamentDetailMetadata,
  tournamentDetailPath,
  tournamentListMetadata,
  tournamentListPath,
} from "@tetraboard/protocol/tournament-pages";
import { openGraphTags } from "@tetraboard/protocol/room-sharing";
import {
  publicFinalStandings,
  publicSummary,
  publicTournament,
  publicTournamentPages,
} from "./adapters/tournament/store";
import { dynamicAssetHeaders, escapeShareHtml, fetchUnconditionalAsset } from "./htmlAssets";

type TournamentPage = ReturnType<typeof tournamentListMetadata> & { body: string; game?: GameId };
type TournamentPages = Awaited<ReturnType<typeof publicTournamentPages>>;
type FinalStandings = Awaited<ReturnType<typeof publicFinalStandings>>;

async function readWithinDeadline<T>(read: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1500);
      }),
    ]);
  } catch {
    console.error("Published tournament data unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function renderStandings(standings: FinalStandings): string {
  const rows = standings.map(
    ({ rank, name, pointsUnits }) =>
      `<tr><td>${escapeShareHtml(String(rank))}位</td><td>${escapeShareHtml(name)}</td><td>${escapeShareHtml(formatTournamentPoints(pointsUnits))}点</td></tr>`,
  );
  return `<h2>順位表</h2><table><thead><tr><th scope="col">順位</th><th scope="col">名前</th><th scope="col">勝ち点</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderDetail(
  tournament: TournamentPublic,
  standings: FinalStandings,
  settings: TournamentSettings,
): string {
  const { name, description, rulesDescription, startsAtMs, endsAtMs, entryCount, status } =
    tournament;
  return `<h1>${escapeShareHtml(name)}</h1>
    <dl>
      <dt>ゲーム</dt><dd>${escapeShareHtml(gameCatalog[settings.game].name)}</dd>
      <dt>開催日時</dt><dd>${escapeShareHtml(tournamentDate(startsAtMs, endsAtMs))}</dd>
      <dt>状態</dt><dd>${escapeShareHtml(tournamentStatusLabels[status])}</dd>
      <dt>エントリー人数</dt><dd>${escapeShareHtml(String(entryCount))}人</dd>
    </dl>
    ${description ? `<p class="whitespace-pre-wrap">${escapeShareHtml(description)}</p>` : ""}
    ${tournament.finalizedAtMs !== null ? renderStandings(standings) : ""}
    <h2>大会ルール</h2>
    ${rulesDescription ? `<p class="whitespace-pre-wrap">${escapeShareHtml(rulesDescription)}</p>` : ""}
    <p>${escapeShareHtml(tournamentRulesSummary)}</p>
    <p>${escapeShareHtml(tournamentSettingsDescription(settings))}</p>
    <p><a href="${escapeShareHtml(tournamentListPath)}">大会一覧へ</a></p>`;
}

const tournamentSections: { title: string; statuses: TournamentStage[] }[] = [
  { title: "開催中", statuses: ["active", "settling"] },
  { title: "次回の大会", statuses: ["upcoming"] },
  { title: "過去の大会", statuses: ["finished"] },
];

function renderList(tournaments: TournamentPages): string {
  const sections = tournamentSections.map(({ title, statuses }) => {
    const items = tournaments
      .filter((tournament) => statuses.includes(tournament.status))
      .map(
        ({ id, name, game, startsAtMs, endsAtMs }) =>
          `<li><a href="${escapeShareHtml(tournamentDetailPath(id))}">${escapeShareHtml(name)}</a> · ${escapeShareHtml(gameCatalog[game].name)} · ${escapeShareHtml(tournamentDate(startsAtMs, endsAtMs))}</li>`,
      );
    return `<section><h2>${escapeShareHtml(title)}</h2><ul>${items.join("")}</ul></section>`;
  });
  return `<h1>大会一覧</h1>${sections.join("")}`;
}

async function readTournamentPage(
  env: Env,
  id: number | undefined,
): Promise<TournamentPage | null> {
  if (id === undefined) {
    const pages = await publicTournamentPages(env.APP_DB);
    return { ...tournamentListMetadata(env.APP_ORIGIN), body: renderList(pages) };
  }
  if (!Number.isSafeInteger(id)) return null;
  const row = await publicTournament(env.APP_DB, id);
  if (!row) return null;
  const [tournament, standings] = await Promise.all([
    publicSummary(env.APP_DB, row),
    publicFinalStandings(env.APP_DB, row),
  ]);
  const settings = getTournamentSettings(tournament);
  return {
    ...tournamentDetailMetadata(env.APP_ORIGIN, { ...tournament, game: settings.game }),
    body: renderDetail(tournament, standings, settings),
    game: settings.game,
  };
}

function rewriteTournamentHtml(response: Response, page: TournamentPage, indexable: boolean) {
  const robots = indexable ? "index,follow" : "noindex,follow";
  const socialTags = openGraphTags(page, page.canonical, page.game)
    .map(({ kind, key, value }) => `<meta ${kind}="${key}" content="${escapeShareHtml(value)}">`)
    .join("");
  const tags =
    `<title>${escapeShareHtml(page.title)}</title>` +
    `<meta name="description" content="${escapeShareHtml(page.description)}">` +
    `<meta name="robots" content="${robots}">` +
    `<link rel="canonical" href="${escapeShareHtml(page.canonical)}">` +
    socialTags;
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
        element.setAttribute("data-public-lobby", "tournaments");
        element.setInnerContent(
          `<main class="mx-auto max-w-5xl p-6 text-ink">
            ${page.body}
            <p role="status" data-startup-status>大会画面を読み込んでいます…</p>
            <a data-startup-reload href="${escapeShareHtml(page.canonical)}">再読み込み</a>
            <nav aria-label="規約とプライバシー">
              <a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a>
            </nav>
          </main>`,
          { html: true },
        );
      },
    })
    .transform(response);
}

export async function serveTournamentHtml(
  request: Request,
  assets: Fetcher,
  env: Env,
  id: number | undefined,
) {
  const [asset, page] = await Promise.all([
    fetchUnconditionalAsset(request, assets, "/app.html"),
    readWithinDeadline(() => readTournamentPage(env, id)),
  ]);
  const headers = dynamicAssetHeaders(asset);
  const indexable = !!page && asset.ok && env.APP_ORIGIN === "https://tetraboard.net";
  if (indexable) headers.delete("X-Robots-Tag");
  else headers.set("X-Robots-Tag", "noindex, follow");
  const status = page === null ? 404 : asset.status;
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status, headers });
  }
  const response = new Response(asset.body, { status, headers });
  return page && asset.ok ? rewriteTournamentHtml(response, page, indexable) : response;
}

function sitemapEntry(origin: string, path: string, lastModifiedAtMs: number | null): string {
  const url = new URL(path, origin).href;
  const date =
    lastModifiedAtMs === null ? "" : new Date(lastModifiedAtMs).toISOString().slice(0, 10);
  return `<url><loc>${escapeShareHtml(url)}</loc>${date ? `<lastmod>${escapeShareHtml(date)}</lastmod>` : ""}</url>`;
}

export async function serveTournamentSitemap(request: Request, assets: Fetcher, env: Env) {
  if (env.APP_ORIGIN !== "https://tetraboard.net") return assets.fetch(request);
  const tournaments = await readWithinDeadline(() => publicTournamentPages(env.APP_DB));
  if (!tournaments) return assets.fetch(request);

  const asset = await fetchUnconditionalAsset(request, assets, "/sitemap.xml");
  if (!asset.ok) return asset;
  const headers = dynamicAssetHeaders(asset);
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status: asset.status, headers });
  }
  const latest = tournaments.reduce<number | null>(
    (max, { lastModifiedAtMs }) =>
      max === null ? lastModifiedAtMs : Math.max(max, lastModifiedAtMs),
    null,
  );
  const entries = [
    sitemapEntry(env.APP_ORIGIN, tournamentListPath, latest),
    ...tournaments.map(({ id, lastModifiedAtMs }) =>
      sitemapEntry(env.APP_ORIGIN, tournamentDetailPath(id), lastModifiedAtMs),
    ),
  ];
  const xml = (await asset.text()).replace("</urlset>", `${entries.join("")}</urlset>`);
  return new Response(xml, { status: asset.status, headers });
}
