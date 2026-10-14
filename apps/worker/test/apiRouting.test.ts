import { AcceptedGameRequest } from "./acceptedGameRequest";
import { exports } from "cloudflare:workers";
import { createRoomContract, getRoomContract, roomSocketContract } from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import worker from "../src/worker";
import { env } from "cloudflare:workers";

test("開発環境は本番へ転送せずHTML・API・エラーを検索対象外にする", async () => {
  const development = {
    ...env,
    APP_ORIGIN: "https://tetraboard-dev.chaossi-lab.workers.dev" as const,
    ASSETS: { fetch: async () => new Response("development") } as unknown as Fetcher,
  };
  for (const path of ["/games/four-reversi", "/api/healthz", "/api/missing", "/admin"]) {
    const response = await worker.fetch(
      new AcceptedGameRequest(`${development.APP_ORIGIN}${path}`),
      development,
      {} as ExecutionContext,
    );
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Location") ?? "").not.toContain("tetraboard.net");
  }
  const response = await worker.fetch(
    new AcceptedGameRequest("https://tetraboard.net/api/healthz"),
    { ...env, APP_ORIGIN: "https://tetraboard.net" },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Robots-Tag")).toBeNull();
});

test("旧公開URLをパス・クエリ付きで本番ドメインへ転送し、APIを実行しない", async () => {
  const response = await worker.fetch(
    new AcceptedGameRequest(
      "https://tetraboard-2026.chaossi-lab.workers.dev/rooms/12345?invite=example",
    ),
    { ...env, APP_ORIGIN: "https://tetraboard.net" },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(308);
  expect(response.headers.get("Location")).toBe(
    "https://tetraboard.net/rooms/12345?invite=example",
  );
});

test("本番のHTTPは画面・API・WebSocketの処理前にHTTPSへ308転送する", async () => {
  const fetchAsset = vi.fn(async () => new Response("unexpected asset"));
  const production = {
    ...env,
    APP_ORIGIN: "https://tetraboard.net" as const,
    ASSETS: { fetch: fetchAsset } as unknown as Fetcher,
  };
  for (const [path, options] of [
    ["/", { method: "GET" }],
    ["/games/four-shogi?source=search", { method: "HEAD" }],
    ["/rooms/12345?invite=example%2Btoken", { method: "GET" }],
    ["/api/healthz", { method: "GET" }],
    ["/api/rooms", { method: "POST", body: "{}" }],
    ["/api/rooms/12345/ws?instanceId=example", { headers: { Upgrade: "websocket" } }],
  ] satisfies [string, RequestInit][]) {
    const response = await worker.fetch(
      new Request(`http://tetraboard.net${path}`, options),
      production,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`https://tetraboard.net${path}`);
  }
  expect(fetchAsset).not.toHaveBeenCalled();
});

test("旧WorkerのHTTPも一度の308転送で本番HTTPSへ移動する", async () => {
  const response = await worker.fetch(
    new Request("http://tetraboard-2026.chaossi-lab.workers.dev/games/four-shogi?source=old"),
    { ...env, APP_ORIGIN: "https://tetraboard.net" },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(308);
  expect(response.headers.get("Location")).toBe(
    "https://tetraboard.net/games/four-shogi?source=old",
  );
});

test("ローカル・開発環境・本番以外のホストのHTTPは本番HTTPSへ転送しない", async () => {
  for (const [origin, appOrigin] of [
    ["http://localhost:8787", "http://localhost:5173"],
    [
      "http://tetraboard-dev.chaossi-lab.workers.dev",
      "https://tetraboard-dev.chaossi-lab.workers.dev",
    ],
    ["http://example.com", "https://tetraboard.net"],
  ] as const) {
    const response = await worker.fetch(
      new Request(`${origin}/api/healthz`),
      { ...env, APP_ORIGIN: appOrigin },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual({ status: "ok" });
  }
});

test("本番の画面・画像をアセットへ渡し、APIと旧プロフィール・棋譜の導線を分ける", async () => {
  const assets = {
    fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`),
  } as Fetcher;
  const production = { ...env, APP_ORIGIN: "https://tetraboard.net" as const, ASSETS: assets };
  for (const [path, target] of [
    ["/rooms/12345", "/app.html"],
    ["/account/matches/example", "/app.html"],
    ["/games/four-shogi", "/games/four-shogi/index.html"],
    ["/assets/logo.svg", "/assets/logo.svg"],
    ["/assets/webp_enc-example.wasm", "/assets/webp_enc-example.wasm"],
    ["/assets/webp_enc_simd-example.wasm", "/assets/webp_enc_simd-example.wasm"],
  ]) {
    const response = await worker.fetch(
      new AcceptedGameRequest(`https://tetraboard.net${path}`),
      production,
      {} as ExecutionContext,
    );
    expect(await response.text()).toBe(`asset:${target}`);
  }
  const health = await worker.fetch(
    new AcceptedGameRequest("https://tetraboard.net/api/healthz"),
    production,
    {} as ExecutionContext,
  );
  expect(await health.json()).toEqual({ status: "ok" });
  const missing = await worker.fetch(
    new AcceptedGameRequest("https://tetraboard.net/api/missing"),
    production,
    {} as ExecutionContext,
  );
  expect(missing.status).toBe(404);
  for (const [path, target] of [
    ["/profile", "/account"],
    ["/games/game-old", "/games/four-reversi"],
    ["/guest/name", "/games/four-reversi"],
  ]) {
    const response = await worker.fetch(
      new AcceptedGameRequest(`https://tetraboard.net${path}`),
      production,
      {} as ExecutionContext,
    );
    expect(response.headers.get("Location")).toBe(`https://tetraboard.net${target}`);
  }
});

test("/api はJSON・認証・WebSocketを既存のルーム処理へ渡す", async () => {
  const base = "https://example.com/api";
  const health = await exports.default.fetch(new AcceptedGameRequest(`${base}/healthz`));
  expect(await health.json()).toEqual({ status: "ok" });
  const created = await exports.default.fetch(
    new AcceptedGameRequest(`${base}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "配信確認", mode: "singles", quickPlay: false }),
    }),
  );
  expect(created.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await created.json());
  try {
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${base}/rooms/${room.id}`),
    );
    expect(getRoomContract.response.parse(await response.json()).room.id).toBe(room.id);
    const me = await exports.default.fetch(
      new AcceptedGameRequest(`${base}/rooms/${room.id}/me`, {
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
    expect(me.status).toBe(200);
    const upgraded = await exports.default.fetch(
      new AcceptedGameRequest(`${base}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(upgraded.status).toBe(101);
    const socket = upgraded.webSocket!;
    socket.accept();
    try {
      const authenticated = new Promise<void>((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          try {
            const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
            if (message.type === "room.authenticated") resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      socket.send(JSON.stringify({ type: "room.auth", token: membership.token }));
      await authenticated;
    } finally {
      socket.close();
    }
    const stale = await exports.default.fetch(
      new AcceptedGameRequest(`${base}/rooms/${room.id}/ws?instanceId=${crypto.randomUUID()}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(stale.status).toBe(410);
  } finally {
    await exports.default.fetch(
      new AcceptedGameRequest(`${base}/rooms/${room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
  }
});

test("未知の /api は画面のHTMLではなく404を返す", async () => {
  const response = await exports.default.fetch(
    new AcceptedGameRequest("https://example.com/api/missing"),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).not.toContain("text/html");
});

test("公開棋譜の直接URLはSPAを配信し、検索対象外にする", async () => {
  const assets = {
    fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`),
  } as Fetcher;
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new AcceptedGameRequest(
        "https://tetraboard.net/matches/00000000-0000-4000-8000-000000000001",
        {
          method,
        },
      ),
      { ...env, APP_ORIGIN: "https://tetraboard.net", ASSETS: assets },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await response.text()).toBe("asset:/app.html");
  }
});
