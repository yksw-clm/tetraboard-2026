import { expect, test } from "bun:test";
import {
  classifyDevice,
  classifyReferrer,
  referrerHostname,
  sanitizeUtm,
} from "../src/acquisition";
import { pageViewInputSchema } from "../src/admin";

test("UTMは許可文字以外を除去した後で64文字に制限し、大小文字を維持する", () => {
  expect(sanitizeUtm(" X /告知?&a-_.9 ")).toBe("Xa-_.9");
  expect(sanitizeUtm("告知".repeat(100) + "A".repeat(65))).toBe("A".repeat(64));
  expect(sanitizeUtm("日本語@ ")).toBeNull();
  expect(sanitizeUtm(null)).toBeNull();
});
test("参照元はHTTPのホストだけを残し、IP・全文・不正値を保持しない", () => {
  expect(referrerHostname("https://WWW.Google.COM/search?q=SECRET#secret", "tetraboard.net")).toBe(
    "www.google.com",
  );
  expect(
    referrerHostname("https://tetraboard.net/rooms/secret?token=secret", "tetraboard.net"),
  ).toBe("internal");
  expect(referrerHostname("", "tetraboard.net")).toBe("direct");
  for (const value of [
    "invalid",
    "file:///private/secret",
    "https://192.0.2.1/secret",
    "https://[2001:db8::1]/secret",
  ])
    expect(referrerHostname(value, "tetraboard.net")).toBeNull();
  for (const [host, category] of [
    ["www.google.com", "search"],
    ["google.co.jp", "search"],
    ["www.bing.com", "search"],
    ["yahoo.co.jp", "search"],
    ["search.yahoo.co.jp", "search"],
    ["search.yahoo.com", "search"],
    ["t.co", "social"],
    ["x.com", "social"],
    ["youtu.be", "social"],
    ["m.youtube.com", "social"],
    ["evilgoogle.com", "other"],
    ["google.com.evil.test", "other"],
    ["accounts.google.com", "other"],
  ])
    expect(classifyReferrer(host!, "tetraboard.net").category).toBe(category);
  expect(classifyReferrer("https://google.com/search?q=SECRET", "tetraboard.net")).toEqual({
    host: null,
    category: null,
  });
});
test("UAは端末3分類だけへ落とし、取得不能は不明として残す", () => {
  for (const [ua, device] of [
    ["Mozilla/5.0 (iPhone) Mobile", "mobile"],
    ["Mozilla/5.0 (iPad)", "tablet"],
    ["Mozilla/5.0 (Linux; Android 14) Mobile", "mobile"],
    ["Mozilla/5.0 (Linux; Android 14)", "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0)", "desktop"],
    ["Mozilla/5.0 (Macintosh)", "desktop"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "desktop"],
  ] as const)
    expect(classifyDevice(ua)).toBe(device);
  expect(classifyDevice(null)).toBeNull();
  expect(classifyDevice("unknown")).toBeNull();
});
test("旧Webの入力を受け付け、URL全文用の余分な項目は受け付けない", () => {
  const base = { id: crypto.randomUUID(), page: "general-lobby", game: null };
  expect(pageViewInputSchema.safeParse(base).success).toBe(true);
  expect(
    pageViewInputSchema.safeParse({
      ...base,
      acquisition: {
        referrer: "direct",
        source: null,
        medium: null,
        campaign: null,
        url: "secret",
      },
    }).success,
  ).toBe(false);
});
