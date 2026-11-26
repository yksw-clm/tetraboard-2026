import { visitContract, type VisitInput } from "@tetraboard/protocol/visits";

const started = new WeakSet<Window>();

function referrerHostname(referrer: string): string | null {
  if (!referrer) return "";
  try {
    const { hostname, protocol } = new URL(referrer);
    if (protocol !== "http:" && protocol !== "https:") return null;
    if (hostname.length <= visitContract.maxReferrerHostLength) return hostname;
    const withoutTrailingDot = hostname.replace(/\.$/, "");
    return withoutTrailingDot.length <= visitContract.maxReferrerHostLength
      ? withoutTrailingDot
      : null;
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

    const input: VisitInput = {
      path,
      referrerHost,
      utmSource: utm("utm_source"),
      utmMedium: utm("utm_medium"),
      utmCampaign: utm("utm_campaign"),
    };
    return JSON.stringify(input);
  }

  const body = serialize(visitContract.maxUtmLength);
  if (encoder.encode(body).length <= visitContract.maxBodyBytes) return body;

  // JSONのエスケープとUTF-8のバイト数を含め、送れる範囲でUTMの先頭を残します。
  let min = 0;
  let max = visitContract.maxUtmLength - 1;
  while (min < max) {
    const middle = Math.ceil((min + max) / 2);
    if (encoder.encode(serialize(middle)).length <= visitContract.maxBodyBytes) min = middle;
    else max = middle - 1;
  }
  return serialize(min);
}

export function startVisits(target: Window = window): void {
  if (started.has(target)) return;
  started.add(target);

  try {
    const { name, content } = visitContract.meta;
    if (!target.document.head?.querySelector(`meta[name="${name}"][content="${content}"]`)) return;
    const { pathname, search } = target.location;

    const body = visitBody(
      pathname.slice(0, visitContract.maxPathLength),
      referrerHostname(target.document.referrer),
      search,
    );
    if (typeof target.navigator.sendBeacon === "function") {
      target.navigator.sendBeacon(
        visitContract.url,
        new Blob([body], { type: "application/json" }),
      );
    } else {
      void target
        .fetch(visitContract.url, {
          method: visitContract.method,
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
