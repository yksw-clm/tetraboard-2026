import { escapeShareHtml } from "./htmlAssets";

export function sitemapEntry(
  origin: string,
  path: string,
  lastModifiedAtMs: number | null,
): string {
  const url = new URL(path, origin).href;
  const date =
    lastModifiedAtMs === null ? "" : new Date(lastModifiedAtMs).toISOString().slice(0, 10);
  return `<url><loc>${escapeShareHtml(url)}</loc>${date ? `<lastmod>${escapeShareHtml(date)}</lastmod>` : ""}</url>`;
}
