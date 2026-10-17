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

export function updatePageMetadata(path: string, room?: ShareRoom): void {
  const game = lobbyGameForPath(path);
  const metadata = path === "/" ? generalLobbyMetadata : game ? lobbyMetadata[game] : null;
  const legalDocument =
    path === "/terms" ? legalDocuments.terms : path === "/privacy" ? legalDocuments.privacy : null;
  document.title = legalDocument
    ? `${legalDocument.title} | TetraBoard`
    : (metadata?.title ?? "TetraBoard");
  // 管理対象だけを取り替え、faviconやviewportなどには触れない。
  for (const element of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]',
  ))
    element.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = metadata && searchIndexable ? "index,follow" : "noindex,follow";
  document.head.append(robots);
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
  if (/^\/tournaments\/[1-9]\d*\/?$/.test(path)) {
    document.title = "四人将棋大会 | TetraBoard";
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = `${publicOrigin}${path.replace(/\/$/, "")}`;
    document.head.append(canonical);
    return;
  }
  if (!metadata) return;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = metadata.description;
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = game ? lobbyCanonical(game) : `${publicOrigin}/`;
  document.head.append(description, canonical);
}
