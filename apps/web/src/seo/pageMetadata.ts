import { lobbyCanonical, lobbyGameForPath, lobbyMetadata, searchIndexable } from "./lobbyMetadata";
import { roomShareMetadata, type ShareRoom } from "@tetraboard/protocol/room-sharing";

export function updatePageMetadata(path: string, room?: ShareRoom): void {
  const game = lobbyGameForPath(path);
  document.title = game ? lobbyMetadata[game].title : "TetraBoard";
  // 管理対象だけを取り替え、faviconやviewportなどには触れない。
  for (const element of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]',
  ))
    element.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = game && searchIndexable ? "index,follow" : "noindex,follow";
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
  if (!game) return;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = lobbyMetadata[game].description;
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = lobbyCanonical(game);
  document.head.append(description, canonical);
}
