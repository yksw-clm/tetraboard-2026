import {
  lobbyCanonical,
  lobbyGameForPath,
  lobbyMetadata,
  searchIndexable,
  generalLobbyMetadata,
  publicOrigin,
} from "./lobbyMetadata";
import { roomShareMetadata, type ShareRoom } from "@tetraboard/protocol/room-sharing";

export function updatePageMetadata(path: string, room?: ShareRoom): void {
  const game = lobbyGameForPath(path);
  const metadata = path === "/" ? generalLobbyMetadata : game ? lobbyMetadata[game] : null;
  document.title = metadata?.title ?? "TetraBoard";
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
  if (!metadata) return;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = metadata.description;
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = game ? lobbyCanonical(game) : `${publicOrigin}/`;
  document.head.append(description, canonical);
}
