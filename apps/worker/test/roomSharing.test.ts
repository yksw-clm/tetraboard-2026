import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { roomSharePath } from "@tetraboard/protocol/room-sharing";
import worker from "../src/worker";
import { escapeShareHtml } from "../src/roomShareHtml";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import type { Room } from "@tetraboard/protocol";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
});

function serve(origin = "https://tetraboard.net", extra: Partial<Env> = {}) {
  const assetRequests: Request[] = [];
  const assets = {
    async fetch(request: Request) {
      assetRequests.push(request);
      return new Response(
        '<!doctype html><html><head><title>Old title</title><meta name="description" content="old"><meta name="robots" content="noindex,follow"><meta property="og:title" content="old"><meta name="twitter:card" content="summary"><link rel="canonical" href="https://old.invalid"></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>',
        {
          headers: {
            "Content-Type": "text/html",
            ETag: '"asset"',
            "Content-Length": "400",
            "Cache-Control": "public",
          },
        },
      );
    },
  } as Fetcher;
  return {
    assetRequests,
    fetch: (path: string, init?: RequestInit) =>
      worker.fetch(
        new Request(`${origin}${path}`, init),
        { ...env, APP_ORIGIN: origin as Env["APP_ORIGIN"], ASSETS: assets, ...extra },
        {} as ExecutionContext,
      ),
  };
}

test("全6ゲームの共有URLは通常UAとクローラーへゲーム別初期HTMLを返し、HEADと条件付き取得でも混在しない", async () => {
  const page = serve();
  for (const game of gameIds) {
    const entry = await fixtures.create({
      name: "ホスト",
      quickPlay: false,
      game,
      ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
    });
    await fixtures.connect(entry);
    const path = roomSharePath(entry.room);
    const user = await page.fetch(path, { headers: { "User-Agent": "Mozilla/5.0" } });
    const bot = await page.fetch(path, { headers: { "User-Agent": "Twitterbot" } });
    const html = await user.text();
    expect(html).toBe(await bot.text());
    expect(html).toContain(`<title>${gameCatalog[game].name}のルーム | TetraBoard</title>`);
    expect(html).toContain(`content="https://tetraboard.net/assets/ogp/${game}.png"`);
    expect(html).toContain(`content="https://tetraboard.net${path}"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html).not.toContain("old.invalid");
    expect(html).toContain('<script src="/assets/app.js"></script>');
    expect(user.headers.get("Cache-Control")).toBe("no-store");
    expect(user.headers.get("ETag")).toBeNull();
    expect(user.headers.get("Content-Length")).toBeNull();
    expect(user.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    const head = await page.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const conditional = await page.fetch(path, {
      headers: { "If-None-Match": '"asset"', "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" },
    });
    expect(conditional.status).toBe(200);
    expect(await conditional.text()).toContain(`/assets/ogp/${game}.png`);
  }
  expect(
    page.assetRequests.every(
      (request) =>
        request.method === "GET" &&
        !request.headers.has("If-None-Match") &&
        !request.headers.has("If-Modified-Since"),
    ),
  ).toBe(true);
});

test("不正・存在しない・期限切れ・世代不一致は共通カードで、メタ情報の障害も画面配信を妨げない", async () => {
  const entry = await fixtures.create({
    name: "ホスト",
    quickPlay: false,
    game: "four-shogi",
    mode: "singles",
  });
  const page = serve();
  for (const path of [
    `/rooms/${entry.room.id}`,
    `/rooms/${entry.room.id}?invite=bad`,
    `/rooms/${entry.room.id}?invite=${crypto.randomUUID()}`,
    `/rooms/${entry.room.id}?invite=${entry.room.instanceId}&invite=${entry.room.instanceId}`,
    `/rooms/bad?invite=${entry.room.instanceId}`,
    `/rooms/99999?invite=${crypto.randomUUID()}`,
  ]) {
    const response = await page.fetch(path);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("/assets/ogp/tetraboard.png");
    expect(html).not.toContain("四人将棋のルーム");
  }
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await runInDurableObject(stub, async (_instance, state) => {
    const room = state.storage.kv.get<Room>("room")!;
    state.storage.kv.put("room", { ...room, lastActivityAtMs: Date.now() - 86400001 });
  });
  expect(await (await page.fetch(roomSharePath(entry.room))).text()).toContain(
    "/assets/ogp/tetraboard.png",
  );
  const failed = serve("https://tetraboard.net", {
    GAME_ROOM: {
      idFromName() {
        throw new Error("unavailable");
      },
    } as unknown as Env["GAME_ROOM"],
  });
  expect(await (await failed.fetch(roomSharePath(entry.room))).text()).toContain('id="root"');
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("room", entry.room);
  });
});

test("共有情報の取得はDO状態・期限・alarmを変更せず、閉鎖相当の復帰期限切れでは共通カードになる", async () => {
  const entry = await fixtures.create({
    name: "ホスト",
    game: "four-reversi",
    quickPlay: true,
    mode: "singles",
  });
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const before = await runInDurableObject(stub, async (_instance, state) => ({
    values: [...state.storage.kv.list()],
    alarm: await state.storage.getAlarm(),
  }));
  await stub.getShareMetadata(entry.room.instanceId);
  const after = await runInDurableObject(stub, async (_instance, state) => ({
    values: [...state.storage.kv.list()],
    alarm: await state.storage.getAlarm(),
  }));
  expect(after).toEqual(before);
  await runInDurableObject(stub, async (_instance, state) => {
    const room = state.storage.kv.get<Room>("room")!;
    state.storage.kv.put("room", {
      ...room,
      players: room.players.map((player) =>
        player.kind === "human" ? { ...player, reconnectDeadline: Date.now() - 1 } : player,
      ),
    });
  });
  expect(await stub.getShareMetadata(entry.room.instanceId)).toBeNull();
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("room", entry.room);
  });
});

test("開発環境の共有画像とURLを本番へ向けず、noindexとエスケープを維持する", async () => {
  const entry = await fixtures.create({ name: "ホスト", quickPlay: false, game: "gomoku" });
  const origin = "https://tetraboard-dev.chaossi-lab.workers.dev";
  const response = await serve(origin).fetch(roomSharePath(entry.room));
  const html = await response.text();
  expect(html).toContain(`${origin}/assets/ogp/gomoku.png`);
  expect(html).not.toContain("https://tetraboard.net");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(escapeShareHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
});

test("共有情報の取得が1500msで完了しなければ共通カードを配信する", async () => {
  vi.useFakeTimers();
  try {
    const page = serve("https://tetraboard.net", {
      GAME_ROOM: {
        idFromName() {
          return {};
        },
        get() {
          return {
            getShareMetadata() {
              return new Promise(() => {});
            },
          };
        },
      } as unknown as Env["GAME_ROOM"],
    });
    const pending = page.fetch(`/rooms/12345?invite=${crypto.randomUUID()}`);
    await vi.advanceTimersByTimeAsync(1500);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/assets/ogp/tetraboard.png");
  } finally {
    vi.useRealTimers();
  }
});
