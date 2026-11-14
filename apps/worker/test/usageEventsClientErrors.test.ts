import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker";

afterEach(() => vi.restoreAllMocks());
const browserId = "01234567-89ab-4cde-8fab-0123456789ab";
const valid = { page: "room", kind: "TypeError", message: "Cannot read property" };

function fixture(fail = false) {
  const write = vi.fn((_point: AnalyticsEngineDataPoint) => {
    if (fail) throw new Error("SECRET");
  });
  const databaseRead = vi.fn(() => {
    throw new Error("client errors must not read D1");
  });
  return {
    write,
    databaseRead,
    fetch(
      body: string | ReadableStream<Uint8Array> | null,
      options: { path?: string; headers?: HeadersInit; binding?: boolean } = {},
    ) {
      const headers = new Headers({ Origin: env.APP_ORIGIN, "Content-Type": "application/json" });
      for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
      return worker.fetch(
        new Request(`http://localhost:8787${options.path ?? "/api/client-errors"}`, {
          method: "POST",
          headers,
          body,
        }),
        {
          ...env,
          APP_DB: { prepare: databaseRead } as unknown as D1Database,
          USAGE_EVENTS:
            options.binding === false
              ? undefined
              : ({ writeDataPoint: write } as unknown as AnalyticsEngineDataset),
        } as Env,
        {} as ExecutionContext,
      );
    },
  };
}

test.each(["/client-errors", "/api/client-errors"])(
  "%s は204とclient_errorを1点だけ返し、本人を調べない",
  async (path) => {
    const client = fixture();
    const response = await client.fetch(JSON.stringify(valid), {
      path,
      headers: {
        Cookie: `unrelated=value; tetraboard-2026.analytics=${browserId}; session=SECRET`,
      },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(client.write.mock.calls).toEqual([
      [
        {
          indexes: ["client_error"],
          blobs: [
            "client_error",
            "0",
            "",
            browserId,
            "",
            "",
            "room",
            "TypeError",
            "Cannot read property",
          ],
          doubles: [],
        },
      ],
    ]);
    expect(client.databaseRead).not.toHaveBeenCalled();
  },
);

test.each([
  "",
  "{",
  "null",
  "[]",
  "1",
  JSON.stringify({ ...valid, page: "unknown" }),
  JSON.stringify({ ...valid, kind: "x".repeat(101) }),
  JSON.stringify({ ...valid, message: "x".repeat(201) }),
  JSON.stringify({ ...valid, kind: null }),
  JSON.stringify({ ...valid, message: 42 }),
  JSON.stringify({ page: "room", kind: "Error" }),
  JSON.stringify({ ...valid, stack: "SECRET" }),
])("不正な本文は400で記録しない: %s", async (body) => {
  const client = fixture();
  expect((await client.fetch(body)).status).toBe(400);
  expect(client.write).not.toHaveBeenCalled();
});

test("2KBちょうどは受理し、Content-Lengthなしの分割本文も実バイト数で制限する", async () => {
  const client = fixture();
  const json = JSON.stringify(valid);
  expect((await client.fetch(json.padEnd(2048))).status).toBe(204);
  const bytes = new TextEncoder().encode(json.padEnd(2049));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1024));
      controller.enqueue(bytes.subarray(1024));
      controller.close();
    },
  });
  expect((await client.fetch(stream)).status).toBe(400);
  expect((await client.fetch(json, { headers: { "Content-Length": "2049" } })).status).toBe(400);
  expect(client.write).toHaveBeenCalledTimes(1);
});

test("日本語と絵文字の文字数上限を受理し、超過は拒否する", async () => {
  const client = fixture();
  const input = { page: "other", kind: "😀".repeat(100), message: "😀".repeat(200) };
  expect((await client.fetch(JSON.stringify(input))).status).toBe(204);
  expect((await client.fetch(JSON.stringify({ ...input, kind: `${input.kind}a` }))).status).toBe(
    400,
  );
  expect(
    (await client.fetch(JSON.stringify({ ...input, message: `${input.message}a` }))).status,
  ).toBe(400);
  expect(client.write.mock.calls[0]![0].blobs?.[8]).toBe(input.message);
});

test.each(["https://example.org", "http://localhost:5173.example.org", "null", ""])(
  "自サイトと一致しないOriginは403: %s",
  async (origin) => {
    const client = fixture();
    expect(
      (await client.fetch(JSON.stringify(valid), { headers: { Origin: origin } })).status,
    ).toBe(403);
    expect(client.write).not.toHaveBeenCalled();
  },
);

test.each([
  "not-a-uuid",
  "01234567-89ab-1cde-8fab-0123456789ab",
  "01234567-89ab-4cde-7fab-0123456789ab",
  `${browserId}extra`,
  "",
])("UUID v4以外の計測Cookieは記録しない: %s", async (value) => {
  const client = fixture();
  expect(
    (
      await client.fetch(JSON.stringify(valid), {
        headers: { Cookie: `tetraboard-2026.analytics=${value}` },
      })
    ).status,
  ).toBe(204);
  expect(client.write.mock.calls[0]![0].blobs?.[3]).toBe("");
});

test("Cookieがなければ識別子を発行せず、大文字のUUID v4は再利用する", async () => {
  const client = fixture();
  const response = await client.fetch(JSON.stringify(valid));
  expect(response.status).toBe(204);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(client.write.mock.calls[0]![0].blobs?.[3]).toBe("");
  await client.fetch(JSON.stringify(valid), {
    headers: { Cookie: `tetraboard-2026.analytics=${browserId.toUpperCase()}` },
  });
  expect(client.write.mock.calls[1]![0].blobs?.[3]).toBe(browserId.toUpperCase());
});

test.each([
  ["Failed https://example.org/a?token=SECRET#SECRET", "Failed https://example.org/a"],
  [
    "(http://example.org/a#SECRET) and https://example.org/b?q=SECRET",
    "(http://example.org/a and https://example.org/b",
  ],
  ["'//example.org/a?invite=SECRET'", "'//example.org/a'"],
  ["https://example.org/a?token=[SECRET](SECRET)", "https://example.org/a"],
])(
  "ブラウザで処理されなかったURLも保存前にクエリとフラグメントを除く: %s",
  async (message, expected) => {
    const client = fixture();
    expect((await client.fetch(JSON.stringify({ ...valid, message }))).status).toBe(204);
    expect(client.write.mock.calls[0]![0].blobs?.[8]).toBe(expected);
    expect(JSON.stringify(client.write.mock.calls)).not.toContain("SECRET");
  },
);

test("書き込みの失敗とbinding未設定でも204にし、エラー内容をログに出さない", async () => {
  const client = fixture(true);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await client.fetch(JSON.stringify(valid))).status).toBe(204);
  expect(warn.mock.calls).toEqual([["Usage event write failed"]]);
  expect((await client.fetch(JSON.stringify(valid), { binding: false })).status).toBe(204);
  expect(client.write).toHaveBeenCalledTimes(1);
});
