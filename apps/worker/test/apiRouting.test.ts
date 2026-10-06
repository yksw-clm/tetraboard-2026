import { exports } from "cloudflare:workers";
import { createRoomContract, getRoomContract, roomSocketContract } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { env } from "cloudflare:workers";

test("旧公開URLをパス・クエリ付きで本番ドメインへ転送し、APIを実行しない", async () => {
  const response = await worker.fetch(
    new Request("https://tetraboard-2026.chaossi-lab.workers.dev/rooms/12345?invite=example"),
    { ...env, APP_ORIGIN: "https://tetraboard.net" },
    {} as ExecutionContext,
  );
  expect(response.status).toBe(308);
  expect(response.headers.get("Location")).toBe(
    "https://tetraboard.net/rooms/12345?invite=example",
  );
});

test("本番の画面・画像をアセットへ渡し、APIと旧プロフィール・棋譜の導線を分ける", async () => {
  const assets = {
    fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`),
  } as Fetcher;
  const production = { ...env, APP_ORIGIN: "https://tetraboard.net" as const, ASSETS: assets };
  for (const path of [
    "/rooms/12345",
    "/account/matches/example",
    "/games/four-shogi",
    "/assets/logo.svg",
  ]) {
    const response = await worker.fetch(
      new Request(`https://tetraboard.net${path}`),
      production,
      {} as ExecutionContext,
    );
    expect(await response.text()).toBe(`asset:${path}`);
  }
  const health = await worker.fetch(
    new Request("https://tetraboard.net/api/healthz"),
    production,
    {} as ExecutionContext,
  );
  expect(await health.json()).toEqual({ status: "ok" });
  const missing = await worker.fetch(
    new Request("https://tetraboard.net/api/missing"),
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
      new Request(`https://tetraboard.net${path}`),
      production,
      {} as ExecutionContext,
    );
    expect(response.headers.get("Location")).toBe(`https://tetraboard.net${target}`);
  }
});

test("/api はJSON・認証・WebSocketを既存のルーム処理へ渡す", async () => {
  const base = "https://example.com/api";
  const health = await exports.default.fetch(new Request(`${base}/healthz`));
  expect(await health.json()).toEqual({ status: "ok" });
  const created = await exports.default.fetch(
    new Request(`${base}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "配信確認", mode: "singles", quickPlay: false }),
    }),
  );
  expect(created.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await created.json());
  try {
    const response = await exports.default.fetch(new Request(`${base}/rooms/${room.id}`));
    expect(getRoomContract.response.parse(await response.json()).room.id).toBe(room.id);
    const me = await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/me`, {
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
    expect(me.status).toBe(200);
    const upgraded = await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
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
      new Request(`${base}/rooms/${room.id}/ws?instanceId=${crypto.randomUUID()}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(stale.status).toBe(410);
  } finally {
    await exports.default.fetch(
      new Request(`${base}/rooms/${room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${membership.token}` },
      }),
    );
  }
});

test("未知の /api は画面のHTMLではなく404を返す", async () => {
  const response = await exports.default.fetch(new Request("https://example.com/api/missing"));
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).not.toContain("text/html");
});

test("公開棋譜の直接URLはSPAを配信し、検索対象外にする", async () => {
  const assets = {
    fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`),
  } as Fetcher;
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new Request("https://tetraboard.net/matches/00000000-0000-4000-8000-000000000001", {
        method,
      }),
      { ...env, APP_ORIGIN: "https://tetraboard.net", ASSETS: assets },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await response.text()).toBe("asset:/index.html");
  }
});
