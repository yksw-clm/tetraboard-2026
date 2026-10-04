import { findPublicPage, publicOrigin } from "./catalog";
export function updatePageMetadata(path: string): void {
  const page = findPublicPage(path);
  document.title = page?.title ?? "TetraBoard";
  function meta(key: string, value: string, property = false) {
    const attr = property ? "property" : "name";
    let element = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
    if (!element) {
      element = document.createElement("meta");
      element.setAttribute(attr, key);
      document.head.append(element);
    }
    element.content = value;
  }
  meta("robots", page ? "index,follow" : "noindex,follow");
  for (const element of document.head.querySelectorAll(
    'link[rel="canonical"], meta[name="description"], meta[property^="og:"]',
  ))
    element.remove();
  if (!page) return;
  meta("description", page.description);
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = `${publicOrigin}${page.path}`;
  document.head.append(canonical);
  for (const [key, value] of Object.entries({
    title: page.title,
    description: page.description,
    url: canonical.href,
    type: "website",
    site_name: "TetraBoard",
    locale: "ja_JP",
  }))
    meta(`og:${key}`, value, true);
}
