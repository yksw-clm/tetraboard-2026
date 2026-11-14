import { expect, test } from "vitest";
import {
  classifyDevice,
  classifyReferrer,
  referrerHostname,
  sanitizeUtm,
} from "../src/usageEvents/acquisition";
const ownHost = "tetraboard.net";

test.each([
  [null, null],
  ["", null],
  [" X /告知?&a-_.9 ", "Xa-_.9"],
  ["日本語@ ", null],
  ["告知".repeat(100) + "A".repeat(65), "A".repeat(64)],
  ["a".repeat(63) + "_B", "a".repeat(63) + "_"],
  ["source\n\t\0test😀", "sourcetest"],
])("UTMは許可文字と64文字制限を保つ: %s", (input, expected) => {
  expect(sanitizeUtm(input)).toBe(expected);
});

test.each([
  ["", "direct"],
  ["https://WWW.Google.COM/search?q=SECRET#secret", "www.google.com"],
  ["https://tetraboard.net/rooms/secret?invite=secret", "internal"],
  ["https://TETRABOARD.NET:8443/path", "internal"],
  ["https://google.com./search", "google.com"],
  ["http://user:password@x.com:8080/path?secret=value", "x.com"],
  ["https://日本語.jp/path", "xn--wgv71a119e.jp"],
  ...[
    "invalid",
    "/relative/path",
    "file:///private/secret",
    "ftp://google.com/private",
    "https://192.0.2.1/secret",
    "https://[2001:db8::1]/secret",
    "http://localhost/path",
    `https://${"a".repeat(64)}.com/`,
    `https://${("a".repeat(63) + ".").repeat(4)}com/`,
  ].map((value) => [value, null]),
])("参照元からパス・クエリ・IPを残さずホストだけを抽出する: %s", (input, expected) => {
  expect(referrerHostname(input!, ownHost)).toBe(expected);
  expect(referrerHostname(input!, "TETRABOARD.NET")).toBe(expected);
});

test("検索・SNSのドメインとそのwww・大小文字・末尾ドットを分類する", () => {
  const groups = {
    search: [
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
    ],
    social: [
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
    ],
  };
  for (const [category, hosts] of Object.entries(groups))
    for (const host of hosts) {
      for (const value of [host, host.toUpperCase(), `${host}.`])
        expect(classifyReferrer(value, ownHost)).toEqual({ host, category });
      expect(classifyReferrer(`www.${host}`, ownHost)).toEqual({ host: `www.${host}`, category });
    }
  for (const value of ["direct", "internal"])
    expect(classifyReferrer(value, ownHost)).toEqual({ host: value, category: value });
  for (const value of [ownHost, ownHost.toUpperCase()])
    expect(classifyReferrer(value, ownHost)).toEqual({ host: "internal", category: "internal" });
  for (const host of ["evilgoogle.com", "google.com.evil.test", "accounts.google.com"])
    expect(classifyReferrer(host, ownHost)).toEqual({ host, category: "other" });
  for (const value of [
    null,
    "",
    "localhost",
    "192.0.2.1",
    "[2001:db8::1]",
    "https://google.com/search?q=SECRET",
    "-bad.example",
    "bad_.example",
    "example.com/path",
    `${"a".repeat(64)}.com`,
    ("a".repeat(63) + ".").repeat(4) + "com",
  ])
    expect(classifyReferrer(value, ownHost)).toEqual({ host: null, category: null });
});

test("端末判定はタブレットを優先し、取得不能と不明も維持する", () => {
  const groups = {
    mobile: [
      "Mozilla/5.0 (iPhone) Mobile",
      "iPod",
      "Windows Phone Mobile",
      "Mozilla/5.0 (Linux; Android 14) Mobile",
      "android mobile",
    ],
    tablet: [
      "Mozilla/5.0 (iPad) Mobile",
      "Tablet",
      "Kindle",
      "Silk",
      "Mozilla/5.0 (Linux; Android 14)",
      "ipad mobile",
    ],
    desktop: [
      "Mozilla/5.0 (Windows NT 10.0)",
      "Mozilla/5.0 (Macintosh)",
      "Mozilla/5.0 (X11; Linux x86_64)",
      "CrOS",
    ],
  };
  for (const [expected, values] of Object.entries(groups))
    for (const ua of values) expect(classifyDevice(ua)).toBe(expected);
  for (const ua of [null, "", "unknown"]) expect(classifyDevice(ua)).toBeNull();
});
