import type { DataRouter } from "react-router";
import type { RoomLoaderData } from "../features/room/roomLoader";
import type { MatchReplayData } from "../features/room/matchReplayLoader";
import {
  lobbyCanonical,
  lobbyGameForPath,
  lobbyMetadata,
  searchIndexable,
  generalLobbyMetadata,
  publicOrigin,
} from "./lobbyMetadata";
import { roomShareMetadata, type ShareRoom } from "@tetraboard/protocol/room-sharing";
import { legalDocuments } from "@tetraboard/protocol/privacy";
import { matchShareMetadata, type ShareMatch } from "@tetraboard/protocol/match-sharing";
import {
  tournamentDetailMetadata,
  tournamentDetailPath,
  tournamentListMetadata,
  tournamentListPath,
  type TournamentPageInfo,
} from "@tetraboard/protocol/tournament-pages";

const tournamentDetailPattern = /^\/tournaments\/[1-9]\d*$/;
let initialTournamentPath: string | undefined;

function isTournamentPage(path: string): boolean {
  return path === tournamentListPath || /^\/tournaments\/[^/]+$/.test(path);
}

export function startPageMetadata(router: DataRouter): () => void {
  let currentPath = router.state.location.pathname.replace(/\/$/, "");
  initialTournamentPath = isTournamentPage(currentPath) ? currentPath : undefined;
  function syncMetadata(state: DataRouter["state"]) {
    const { pathname } = state.location;
    const nextPath = pathname.replace(/\/$/, "");
    if (nextPath !== currentPath) {
      initialTournamentPath = undefined;
      currentPath = nextPath;
    } else if (isTournamentPage(nextPath)) {
      // 遅延ルートの準備や再検証では、表示中の大会のメタ情報を保持します。
      return;
    }
    const data = state.errors ? undefined : (state.loaderData.room as RoomLoaderData | undefined);
    const replay = state.errors
      ? undefined
      : (state.loaderData["public-match"] as MatchReplayData | undefined);
    updatePageMetadata(pathname, data?.room, replay?.match);
  }
  syncMetadata(router.state);
  const stop = router.subscribe(syncMetadata);
  return () => {
    stop();
    initialTournamentPath = undefined;
  };
}

export function updatePageMetadata(
  path: string,
  room?: ShareRoom,
  match?: ShareMatch,
  tournament?: TournamentPageInfo,
): void {
  const currentPath = path.replace(/\/$/, "");
  if (currentPath === initialTournamentPath) return;
  const isDetail = tournamentDetailPattern.test(currentPath);
  const isList = currentPath === tournamentListPath;
  const tournamentMetadata = isList
    ? tournamentListMetadata(publicOrigin)
    : isDetail && tournament && currentPath === tournamentDetailPath(tournament.id)
      ? tournamentDetailMetadata(publicOrigin, tournament)
      : null;
  const game = lobbyGameForPath(path);
  const metadata =
    tournamentMetadata ?? (path === "/" ? generalLobbyMetadata : game ? lobbyMetadata[game] : null);
  const legalDocument =
    path === "/terms" ? legalDocuments.terms : path === "/privacy" ? legalDocuments.privacy : null;
  document.title = legalDocument
    ? `${legalDocument.title} | TetraBoard`
    : currentPath === "/how-to-play"
      ? "遊び方 | TetraBoard"
      : (metadata?.title ?? (isDetail ? "大会｜TetraBoard" : "TetraBoard"));
  // 管理対象だけを取り替え、faviconやviewportなどには触れない。
  for (const element of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]',
  ))
    element.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = metadata && searchIndexable ? "index,follow" : "noindex,follow";
  document.head.append(robots);
  if (
    match &&
    /^\/matches\/[^/]+\/?$/.test(path) &&
    path.replace(/\/$/, "") === `/matches/${match.id}`
  ) {
    const metadata = matchShareMetadata(window.location.origin, match);
    document.title = metadata.title;
    for (const { kind, key, value } of metadata.tags) {
      const tag = document.createElement("meta");
      tag.setAttribute(kind, key);
      tag.content = value;
      document.head.append(tag);
    }
    return;
  }
  if (/^\/rooms\/[^/]+\/?$/.test(path)) {
    const currentRoom = room && path.replace(/\/$/, "") === `/rooms/${room.id}` ? room : null;
    const metadata = roomShareMetadata(window.location.origin, currentRoom);
    document.title = metadata.title;
    for (const { kind, key, value } of metadata.tags) {
      const tag = document.createElement("meta");
      tag.setAttribute(kind, key);
      tag.content = value;
      document.head.append(tag);
    }
    return;
  }
  const siteName = document.createElement("meta");
  siteName.setAttribute("property", "og:site_name");
  siteName.content = "TetraBoard";
  document.head.append(siteName);
  if (!metadata) return;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = metadata.description;
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href =
    tournamentMetadata?.canonical ?? (game ? lobbyCanonical(game) : `${publicOrigin}/`);
  document.head.append(description, canonical);
}
