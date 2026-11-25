const started = new WeakSet<Window>();
const maxPathLength = 1024;
const maxUtmLength = 256;
const maxReferrerHostLength = 253;
const maxBodyBytes = 2048;

function referrerHostname(referrer: string): string | null {
  if (!referrer) return "";
  try {
    const { hostname, protocol } = new URL(referrer);
    if (protocol !== "http:" && protocol !== "https:") return null;
    if (hostname.length <= maxReferrerHostLength) return hostname;
    const withoutTrailingDot = hostname.replace(/\.$/, "");
    return withoutTrailingDot.length <= maxReferrerHostLength ? withoutTrailingDot : null;
  } catch {
    return null;
  }
}

function visitBody(path: string, referrerHost: string | null, search: string): string {
  const params = new URLSearchParams(search);
  const encoder = new TextEncoder();

  function serialize(utmLength: number) {
    const utm = (name: string) =>
      params
        .get(name)
        ?.slice(0, utmLength)
        .replace(/[\uD800-\uDBFF]$/u, "") ?? null;

    return JSON.stringify({
      path,
      referrerHost,
      utmSource: utm("utm_source"),
      utmMedium: utm("utm_medium"),
      utmCampaign: utm("utm_campaign"),
    });
  }

  const body = serialize(maxUtmLength);
  if (encoder.encode(body).length <= maxBodyBytes) return body;

  // JSONのエスケープとUTF-8のバイト数を含め、送れる範囲でUTMの先頭を残します。
  let min = 0;
  let max = maxUtmLength - 1;
  while (min < max) {
    const middle = Math.ceil((min + max) / 2);
    if (encoder.encode(serialize(middle)).length <= maxBodyBytes) min = middle;
    else max = middle - 1;
  }
  return serialize(min);
}

export function startVisits(target: Window = window): void {
  if (started.has(target)) return;
  started.add(target);

  try {
    const { pathname, search } = target.location;
    if (
      ["/privacy", "/terms", "/admin"].includes(pathname) ||
      pathname.startsWith("/admin/") ||
      target.document.querySelector("[data-not-found]")
    )
      return;

    const body = visitBody(
      pathname.slice(0, maxPathLength),
      referrerHostname(target.document.referrer),
      search,
    );
    if (typeof target.navigator.sendBeacon === "function") {
      target.navigator.sendBeacon("/api/visits", new Blob([body], { type: "application/json" }));
    } else {
      void target
        .fetch("/api/visits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        })
        .catch(() => {});
    }
  } catch {
    // 計測の失敗を新たな未処理エラーにしません。
  }
}

if (typeof window !== "undefined") startVisits();
