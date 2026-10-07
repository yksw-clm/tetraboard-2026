import { lobbyCanonical, lobbyGameForPath, lobbyMetadata } from "./lobbyMetadata";

export function updatePageMetadata(path: string): void {
  const game = lobbyGameForPath(path);
  document.title = game ? lobbyMetadata[game].title : "TetraBoard";
  // 管理対象だけを取り替え、faviconやviewportなどには触れない。
  for (const element of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], link[rel="canonical"]',
  ))
    element.remove();
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = game ? "index,follow" : "noindex,follow";
  document.head.append(robots);
  if (!game) return;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = lobbyMetadata[game].description;
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = lobbyCanonical(game);
  document.head.append(description, canonical);
}
