import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { visitContract, type VisitInput } from "@tetraboard/protocol/visits";
import { startVisits } from "../src/shared/visits";

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((target) => target.happyDOM.close()));
});

const defaultVisit: VisitInput = {
  path: "/",
  referrerHost: "",
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
};
const longestHostname = `${`${"a".repeat(63)}.`.repeat(3)}${"b".repeat(61)}`;

function browser(path = "/", referrer = "", marker: string | null = visitContract.meta.content) {
  const target = new Window({ url: `https://tetraboard.test${path}` });
  windows.push(target);
  if (marker !== null)
    target.document.head.innerHTML = `<meta name="${visitContract.meta.name}" content="${marker}">`;
  const beacon = mock((_url: string, _body: Blob) => true);
  const fetch = mock((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  Object.defineProperty(target.document, "referrer", { value: referrer });
  Object.defineProperty(target.navigator, "sendBeacon", { configurable: true, value: beacon });
  Object.defineProperty(target, "fetch", { configurable: true, value: fetch });
  return {
    target,
    beacon,
    fetch,
    start: () => startVisits(target as unknown as globalThis.Window),
  };
}

test("目印がある文書は起動時だけ送信し、同じ画面の再初期化やpushStateでは送らない", async () => {
  const client = browser();
  client.start();
  expect(client.beacon).toHaveBeenCalledTimes(1);
  const [url, body] = client.beacon.mock.calls[0]!;
  expect(url).toBe("/api/visits");
  expect(body.type.split(";")[0]).toBe("application/json");
  expect(JSON.parse(await body.text())).toEqual(defaultVisit);
  client.target.history.pushState(null, "", "/rooms/12345");
  client.start();
  expect(client.beacon).toHaveBeenCalledTimes(1);
  expect(client.fetch).not.toHaveBeenCalled();
});

test.each([
  ["https://WWW.Google.COM/search?q=secret#secret", "www.google.com"],
  ["http://user:password@x.com:8080/path?secret=value", "x.com"],
  ["https://日本語.jp/path", "xn--wgv71a119e.jp"],
  ["http://192.0.2.1/private", "192.0.2.1"],
  ["http://[2001:db8::1]/private", "[2001:db8::1]"],
  ["http://localhost/private", "localhost"],
  [`https://${"a".repeat(64)}.com/private`, `${"a".repeat(64)}.com`],
  [`https://${longestHostname}./private`, longestHostname],
  [`https://${longestHostname}a/private`, null],
  ["file:///private/secret", null],
  ["ftp://google.com/private", null],
  ["android-app://com.google.android.gm/", null],
  ["invalid", null],
  ["/relative/path", null],
])("参照元のホストだけとアクセス先のパス・UTMを送る: %s", async (referrer, host) => {
  const client = browser(
    "/rooms/12345?utm_source=news&utm_medium=search&utm_campaign=example%20campaign&token=secret#secret",
    referrer,
  );
  client.start();
  expect(JSON.parse(await client.beacon.mock.calls[0]![1].text())).toEqual({
    path: "/rooms/12345",
    referrerHost: host,
    utmSource: "news",
    utmMedium: "search",
    utmCampaign: "example campaign",
  });
});

test.each([
  { value: "a", referrer: "", fits: true },
  { value: "a", referrer: `https://${longestHostname}/`, fits: false },
  { value: "あ", referrer: "", fits: false },
  { value: "😀", referrer: "", fits: false },
  { value: "\0", referrer: "", fits: false },
])("長いパスとUTMでも本文を2048バイト以内に収める: $value", async ({ value, referrer, fits }) => {
  const path = `/rooms/${"x".repeat(4000)}`;
  const utms = [
    `source-${value.repeat(1000)}`,
    `medium-${value.repeat(1000)}`,
    `campaign-${value.repeat(1000)}`,
  ];
  const search = new URLSearchParams({
    utm_source: utms[0]!,
    utm_medium: utms[1]!,
    utm_campaign: utms[2]!,
  });
  const client = browser(`${path}?${search}`, referrer);
  client.start();
  const body = client.beacon.mock.calls[0]![1];
  expect(body.size).toBeLessThanOrEqual(2048);
  const { path: sentPath, utmSource, utmMedium, utmCampaign } = JSON.parse(await body.text());
  expect(sentPath).toBe(path.slice(0, 1024));
  for (const [index, sent] of [utmSource, utmMedium, utmCampaign].entries()) {
    expect(sent.length).toBeGreaterThan(utms[index]!.indexOf("-") + 1);
    expect(utms[index]!.startsWith(sent)).toBe(true);
    if (fits) expect(sent.length).toBe(256);
    else expect(sent.length).toBeLessThan(256);
  }
});

test.each([null, "disabled"])("有効な目印がない文書は送信しない: %s", (marker) => {
  const client = browser("/tournaments/12345", "", marker);
  client.start();
  client.target.history.pushState(null, "", "/");
  client.start();
  expect(client.beacon).not.toHaveBeenCalled();
  expect(client.fetch).not.toHaveBeenCalled();
});

test("sendBeaconがなければPOSTとkeepaliveで送り、拒否を未処理にしない", async () => {
  const client = browser("/rooms/12345");
  Object.defineProperty(client.target.navigator, "sendBeacon", { value: undefined });
  client.fetch.mockRejectedValueOnce(new Error("offline"));
  expect(() => client.start()).not.toThrow();
  await Promise.resolve();
  expect(client.fetch.mock.calls).toEqual([
    [
      "/api/visits",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...defaultVisit, path: "/rooms/12345" }),
        keepalive: true,
      },
    ],
  ]);
});

test.each([false, new Error("blocked")])("sendBeaconが失敗しても再送しない: %s", (result) => {
  const client = browser();
  client.beacon.mockImplementationOnce(() => {
    if (result instanceof Error) throw result;
    return result;
  });
  expect(() => client.start()).not.toThrow();
  client.start();
  expect(client.beacon).toHaveBeenCalledTimes(1);
  expect(client.fetch).not.toHaveBeenCalled();
});
