import { boardPostPath } from "@tetraboard/protocol/board-presentation";
import { fourShogiRulesPath, type GameId } from "@tetraboard/protocol/games";
import { publicPlayerPagePathPattern } from "@tetraboard/protocol";
import type { DataRouter } from "react-router";
import type { RoomLoaderData } from "../features/room/roomLoader";
import type { MatchReplayData } from "../features/room/matchReplayLoader";
import { matchedBoardPostNumber } from "../shared/siteNavigation";
import { howToPlayMetadata, howToPlayPath } from "./howToPlayMetadata";
import {
  lobbyCanonical,
  lobbyGameForPath,
  lobbyMetadata,
  searchIndexable,
  generalLobbyMetadata,
  publicOrigin,
} from "./lobbyMetadata";
import {
  openGraphTags,
  roomShareMetadata,
  type ShareRoom,
} from "@tetraboard/protocol/room-sharing";
import { legalDocuments } from "@tetraboard/protocol/privacy";
import { matchShareMetadata, type ShareMatch } from "@tetraboard/protocol/match-sharing";
import {
  tournamentDetailMetadata,
  tournamentDetailPath,
  tournamentListMetadata,
  tournamentListPath,
  type TournamentPageInfo,
} from "@tetraboard/protocol/tournament-pages";

type PublicPageMetadata = { title: string; description: string };
type BoardPageMetadata = PublicPageMetadata & {
  path: string;
  canonical: string;
  indexable: boolean;
  game: GameId;
  jsonLd: string | null;
};

const tournamentDetailPattern = /^\/tournaments\/[1-9]\d*$/;
let initialServerPagePath: string | undefined;

function isServerPage(path: string): boolean {
  return path === tournamentListPath || /^\/(?:tournaments|posts)\/[^/]+$/.test(path);
}

export function isInitialServerPage(path: string): boolean {
  return path === initialServerPagePath;
}

function metadataPath({ location, matches }: DataRouter["state"]): string {
  // 履歴の正規化で同じ投稿の初期メタ情報を消さないようにします。
  const number = matchedBoardPostNumber(location.pathname, matches.at(-1)?.params.id);
  return number === null ? location.pathname.replace(/\/$/, "") : boardPostPath(number);
}

export function startPageMetadata(router: DataRouter, root?: HTMLElement): () => void {
  let currentPath = metadataPath(router.state);
  initialServerPagePath = isServerPage(currentPath) ? currentPath : undefined;
  function syncMetadata(state: DataRouter["state"]) {
    const { pathname } = state.location;
    const nextPath = metadataPath(state);
    if (nextPath !== currentPath) {
      document.head.querySelector('script[type="application/ld+json"]')?.remove();
      initialServerPagePath = undefined;
      currentPath = nextPath;
    } else if (isServerPage(nextPath)) {
      // 遅延ルートの準備や再検証では、表示中のページのメタ情報を保持します。
      return;
    }
    const data = state.errors ? undefined : (state.loaderData.room as RoomLoaderData | undefined);
    const replay = state.errors
      ? undefined
      : (state.loaderData["public-match"] as MatchReplayData | undefined);
    // ルールと利用ガイドの初期HTMLが表示されている間は、そのメタ情報も残します。
    const initialMarker =
      nextPath === fourShogiRulesPath
        ? "four-shogi-rules"
        : nextPath === howToPlayPath
          ? "how-to-play"
          : undefined;
    if (
      initialMarker &&
      (!state.initialized || (state.errors && root?.dataset.publicLobby === initialMarker))
    )
      return;
    const handle = state.matches.at(-1)?.route.handle as
      | { pageMetadata?: PublicPageMetadata }
      | undefined;
    updatePageMetadata(pathname, data?.room, replay?.match, undefined, handle?.pageMetadata);
  }
  syncMetadata(router.state);
  const stop = router.subscribe(syncMetadata);
  return () => {
    stop();
    initialServerPagePath = undefined;
  };
}

export function updatePageMetadata(
  path: string,
  room?: ShareRoom,
  match?: ShareMatch,
  tournament?: TournamentPageInfo,
  publicPage?: PublicPageMetadata,
  board?: BoardPageMetadata | null,
): void {
  const currentPath = path.replace(/\/$/, "");
  const boardPage = board?.path === currentPath ? board : undefined;
  const initial = isInitialServerPage(currentPath);
  if (initial && !boardPage && board !== null) return;
  if (initial) document.head.querySelector('script[type="application/ld+json"]')?.remove();
  const isDetail = tournamentDetailPattern.test(currentPath);
  const isList = currentPath === tournamentListPath;
  const tournamentMetadata = isList
    ? tournamentListMetadata(publicOrigin)
    : isDetail && tournament && currentPath === tournamentDetailPath(tournament.id)
      ? tournamentDetailMetadata(publicOrigin, tournament)
      : null;
  const game = lobbyGameForPath(path);
  const staticPage = publicPage ?? (currentPath === howToPlayPath ? howToPlayMetadata : undefined);
  const metadata =
    staticPage ??
    boardPage ??
    tournamentMetadata ??
    (path === "/" ? generalLobbyMetadata : game ? lobbyMetadata[game] : null);
  const legalDocument =
    path === "/terms" ? legalDocuments.terms : path === "/privacy" ? legalDocuments.privacy : null;
  const isPlayer = publicPlayerPagePathPattern.test(currentPath);
  document.title = legalDocument
    ? `${legalDocument.title} | TetraBoard`
    : (metadata?.title ??
      (isDetail ? "大会｜TetraBoard" : isPlayer ? "プレイヤーページ | TetraBoard" : "TetraBoard"));
  // 管理対象だけを取り替え、faviconやviewportなどには触れない。
  for (const element of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]',
  ))
    element.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  const indexable = boardPage?.indexable ?? (searchIndexable && Boolean(metadata));
  robots.content = indexable ? "index,follow" : "noindex,follow";
  document.head.append(robots);
  if (
    match &&
    /^\/matches\/[^/]+\/?$/.test(path) &&
    path.replace(/\/$/, "") === `/matches/${match.id}`
  ) {
    const metadata = matchShareMetadata(window.location.origin, match);
    document.title = metadata.title;
    for (const tag of metadata.tags) appendMetaTag(tag);
    return;
  }
  if (/^\/rooms\/[^/]+\/?$/.test(path)) {
    const currentRoom = room && path.replace(/\/$/, "") === `/rooms/${room.id}` ? room : null;
    const metadata = roomShareMetadata(window.location.origin, currentRoom);
    document.title = metadata.title;
    for (const tag of metadata.tags) appendMetaTag(tag);
    return;
  }
  if (!metadata) {
    appendMetaTag({ kind: "property", key: "og:site_name", value: "TetraBoard" });
    return;
  }
  appendMetaTag({ kind: "name", key: "description", value: metadata.description });
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  const canonicalUrl =
    boardPage?.canonical ??
    tournamentMetadata?.canonical ??
    (game ? lobbyCanonical(game) : `${publicOrigin}${staticPage ? currentPath : "/"}`);
  canonical.href = canonicalUrl;
  document.head.append(canonical);
  const imageGame =
    boardPage?.game ??
    game ??
    (currentPath === fourShogiRulesPath ? "four-shogi" : isDetail ? tournament?.game : undefined);
  for (const tag of openGraphTags(metadata, canonicalUrl, imageGame)) appendMetaTag(tag);
  if (initial && boardPage?.jsonLd) document.head.insertAdjacentHTML("beforeend", boardPage.jsonLd);
}

function appendMetaTag({
  kind,
  key,
  value,
}: {
  kind: "name" | "property";
  key: string;
  value: string;
}): void {
  const tag = document.createElement("meta");
  tag.setAttribute(kind, key);
  tag.content = value;
  document.head.append(tag);
}
