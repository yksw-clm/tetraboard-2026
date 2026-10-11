import { analyticsPreferenceCookie } from "@tetraboard/protocol/privacy";
import { createUuid } from "../shared/createUuid";
export const analyticsPreferenceStorageKey = "tetraboard:analytics-choice";
export function analyticsEnabled() {
  return !document.cookie.split(";").some((v) => v.trim() === `${analyticsPreferenceCookie}=off`);
}
function memberships() {
  const values: { roomId: string; token: string }[] = [];
  try {
    for (let i = 0; i < sessionStorage.length && values.length < 10; i++) {
      const key = sessionStorage.key(i),
        roomId = key?.match(/^tetraboard:room:(\d{5}):membership$/)?.[1];
      const token = key ? sessionStorage.getItem(key) : null;
      if (roomId && token && /^[0-9a-f]{64}$/.test(token)) values.push({ roomId, token });
    }
  } catch {
    /* 保存できない端末ではCookieと新しい参加に反映します。 */
  }
  return values;
}
function sendPreference(enabled: boolean) {
  const seats = memberships();
  return fetch("/api/analytics/choice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, ...(seats.length ? { memberships: seats } : {}) }),
    credentials: "same-origin",
    keepalive: true,
  });
}
export function syncAnalyticsPreference() {
  if (memberships().length) void sendPreference(analyticsEnabled()).catch(() => undefined);
}
export async function setAnalyticsEnabled(enabled: boolean) {
  const attributes = `Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  let request: Promise<Response>;
  if (enabled) {
    document.cookie = `${analyticsPreferenceCookie}=on; ${attributes}`;
    document.cookie = `tetraboard-2026.analytics=${createUuid()}; ${attributes}`;
    request = sendPreference(true);
  } else {
    // 発行済みCookieで、他タブのゲスト席にも停止を通知します。
    request = sendPreference(false);
    document.cookie = `${analyticsPreferenceCookie}=off; ${attributes}`;
    document.cookie =
      "tetraboard-2026.analytics=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  }
  try {
    localStorage.setItem(analyticsPreferenceStorageKey, String(enabled));
  } catch {
    /* Cookieを使います。 */
  }
  window.dispatchEvent(new Event("analytics-choice"));
  const response = await request;
  if (!response.ok) throw new Error("計測設定を保存できません。");
}
