export function sanitizeUtm(value: string | null) {
  return value?.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || null;
}

function hostname(value: string) {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  return normalized.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(normalized)
    ? normalized
    : null;
}

export function referrerHostname(referrer: string, ownHostname: string): string | null {
  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.hostname.toLowerCase() === ownHostname.toLowerCase()) return "internal";
    return hostname(url.hostname);
  } catch {
    return null;
  }
}

export function classifyReferrer(value: string | null, ownHostname: string) {
  if (value === "direct" || value === "internal") return { host: value, category: value };
  if (value?.toLowerCase() === ownHostname.toLowerCase())
    return { host: "internal", category: "internal" };
  const host = value && hostname(value);
  if (!host) return { host: null, category: null };
  const matches = (domains: string[]) =>
    domains.some((domain) => host === domain || host === `www.${domain}`);
  const category = matches([
    "google.com",
    "google.co.jp",
    "bing.com",
    "yahoo.co.jp",
    "search.yahoo.co.jp",
    "yahoo.com",
    "search.yahoo.com",
    "duckduckgo.com",
    "search.brave.com",
    "ecosia.org",
  ])
    ? "search"
    : matches([
          "x.com",
          "t.co",
          "twitter.com",
          "youtube.com",
          "m.youtube.com",
          "youtu.be",
          "facebook.com",
          "m.facebook.com",
          "l.facebook.com",
          "instagram.com",
          "threads.net",
          "twitch.tv",
          "discord.com",
          "discord.gg",
          "bsky.app",
          "reddit.com",
          "line.me",
        ])
      ? "social"
      : "other";
  return { host, category };
}

export function classifyDevice(userAgent: string | null): "mobile" | "tablet" | "desktop" | null {
  if (!userAgent) return null;
  if (/iPad|Tablet|Kindle|Silk|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  if (/Mobile|iPhone|iPod|Windows Phone/i.test(userAgent)) return "mobile";
  return /Windows|Macintosh|X11|CrOS|Linux/i.test(userAgent) ? "desktop" : null;
}
