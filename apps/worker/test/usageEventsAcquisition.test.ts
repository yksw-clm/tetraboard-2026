import { expect, test } from "vitest";
import * as legacy from "@tetraboard/protocol";
import {
  classifyDevice,
  classifyReferrer,
  referrerHostname,
  sanitizeUtm,
} from "../src/usageEvents/acquisition";

const ownHost = "tetraboard.net";

test("UTMは旧分類と同じ許可文字・64文字制限・大小文字・空値を保つ", () => {
  for (const value of [
    null,
    "",
    " X /告知?&a-_.9 ",
    "日本語@ ",
    "告知".repeat(100) + "A".repeat(65),
    "a".repeat(63) + "_B",
    "source\n\t\0test😀",
  ])
    expect(sanitizeUtm(value)).toBe(legacy.sanitizeUtm(value));
});

test("参照元のホスト抽出は旧分類と同じで、パス・クエリ・IPを残さない", () => {
  for (const value of [
    "",
    "https://WWW.Google.COM/search?q=SECRET#secret",
    "https://tetraboard.net/rooms/secret?invite=secret",
    "https://TETRABOARD.NET:8443/path",
    "https://google.com./search",
    "http://user:password@x.com:8080/path?secret=value",
    "https://日本語.jp/path",
    "invalid",
    "/relative/path",
    "file:///private/secret",
    "ftp://google.com/private",
    "https://192.0.2.1/secret",
    "https://[2001:db8::1]/secret",
    "http://localhost/path",
    `https://${"a".repeat(64)}.com/`,
    `https://${("a".repeat(63) + ".").repeat(4)}com/`,
  ]) {
    expect(referrerHostname(value, ownHost)).toBe(legacy.referrerHostname(value, ownHost));
    expect(referrerHostname(value, "TETRABOARD.NET")).toBe(
      legacy.referrerHostname(value, "TETRABOARD.NET"),
    );
  }
});

test("検索・SNSの全ドメインと不正ホストは旧分類と同じ結果になる", () => {
  const hosts = [
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
  ];
  for (const value of [
    ...hosts.flatMap((host) => [host, `www.${host}`, host.toUpperCase(), `${host}.`]),
    "direct",
    "internal",
    ownHost,
    ownHost.toUpperCase(),
    null,
    "",
    "localhost",
    "192.0.2.1",
    "[2001:db8::1]",
    "evilgoogle.com",
    "google.com.evil.test",
    "accounts.google.com",
    "https://google.com/search?q=SECRET",
    "-bad.example",
    "bad_.example",
    "example.com/path",
    `${"a".repeat(64)}.com`,
    ("a".repeat(63) + ".").repeat(4) + "com",
  ])
    expect(classifyReferrer(value, ownHost)).toEqual(legacy.classifyReferrer(value, ownHost));
});

test("端末判定は旧分類と同じ優先順で、取得不能と不明も維持する", () => {
  for (const ua of [
    null,
    "",
    "unknown",
    "Mozilla/5.0 (iPhone) Mobile",
    "iPod",
    "Windows Phone Mobile",
    "Mozilla/5.0 (iPad) Mobile",
    "Tablet",
    "Kindle",
    "Silk",
    "Mozilla/5.0 (Linux; Android 14) Mobile",
    "Mozilla/5.0 (Linux; Android 14)",
    "Mozilla/5.0 (Windows NT 10.0)",
    "Mozilla/5.0 (Macintosh)",
    "Mozilla/5.0 (X11; Linux x86_64)",
    "CrOS",
    "android mobile",
    "ipad mobile",
  ])
    expect(classifyDevice(ua)).toBe(legacy.classifyDevice(ua));
});
