import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import worker from "../src/worker";

const browserId = "01234567-89ab-4cde-8fab-0123456789ab";
const game = "four-shogi";
const valid = JSON.stringify({ game });

function fixture(fail = false) {
  const write = vi.fn((_point: AnalyticsEngineDataPoint) => {
    if (fail) throw new Error("unavailable");
  });
  const databaseRead = vi.fn(() => {
    throw new Error("board preview views must not read D1");
  });
  const assetsFetch = vi.fn(() => new Response(null, { status: 404 }));
  return {
    write,
    databaseRead,
    assetsFetch,
    post({
      body = valid,
      overrides = {},
    }: { body?: string; overrides?: Record<string, string | null> } = {}) {
      const headers = new Headers({
        Origin: env.APP_ORIGIN,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 Chrome/130.0.0.0",
        Cookie: `tetraboard-2026.analytics=${browserId}; session=example`,
      });
      for (const [name, value] of Object.entries(overrides)) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      return worker.fetch(
        new Request("http://localhost:8787/api/board-preview-views", {
          method: "POST",
          headers,
          body,
        }),
        {
          ...env,
          ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
          APP_DB: { prepare: databaseRead } as unknown as D1Database,
          USAGE_EVENTS: { writeDataPoint: write } as unknown as AnalyticsEngineDataset,
        },
        {} as ExecutionContext,
      );
    },
  };
}

test("/api/board-preview-views はゲームとブラウザIDを1点記録し、D1を読まない", async () => {
  const client = fixture();
  const response = await client.post();
  expect(response.status).toBe(204);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(client.write.mock.calls).toEqual([
    [
      {
        indexes: ["board_preview_viewed"],
        blobs: ["board_preview_viewed", "0", game, browserId, "", ""],
        doubles: [],
      },
    ],
  ]);
  expect(client.databaseRead).not.toHaveBeenCalled();
  expect(client.assetsFetch).not.toHaveBeenCalled();
});

test.each([
  ["Cookie", null],
  ["Cookie", "tetraboard-2026.analytics=invalid"],
  ["User-Agent", null],
  ["User-Agent", "curl/8.7.1"],
  ["User-Agent", "Mozilla/5.0 Googlebot"],
  ["User-Agent", "Mozilla/5.0 HeadlessChrome"],
] as const)("%s が %s の場合は記録せず204を返す", async (header, value) => {
  const client = fixture();
  expect((await client.post({ overrides: { [header]: value } })).status).toBe(204);
  expect(client.write).not.toHaveBeenCalled();
});

test.each([null, "https://example.org"])(
  "自サイトと一致しないOrigin %s は403を返す",
  async (origin) => {
    const client = fixture();
    const response = await client.post({ overrides: { Origin: origin } });
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(client.write).not.toHaveBeenCalled();
  },
);

test.each([
  ["不正なJSON", "{"],
  ["ゲームなし", "{}"],
  ["未知のゲーム", JSON.stringify({ game: "all" })],
  ["余分な項目", JSON.stringify({ game, accountId: "example" })],
  ["本文の上限超過", valid.padEnd(257)],
])("%s は記録せず400を返す", async (_label, body) => {
  const client = fixture();
  const response = await client.post({ body });
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(client.write).not.toHaveBeenCalled();
});

test("書き込みに失敗しても204を返す", async () => {
  const client = fixture(true);
  expect((await client.post()).status).toBe(204);
  expect(client.write).toHaveBeenCalledTimes(1);
});
