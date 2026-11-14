import { test, expect } from "bun:test";
import { Api } from "../src/api";
import { Queue } from "../src/queue";
import { StopControl } from "../src/session";
import { runConfigSchema, scope } from "../src/config";
import { ids, instanceId, token } from "./fixtures";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  matchmakingInputSchema,
  matchmakingControlSchema,
  tournamentControllerInputSchema,
  tournamentQueueInputSchema,
} from "@tetraboard/protocol";
import type { BotState } from "../src/store";

const operationId = "00000000-0000-4000-8000-000000000030";
const controllerId = "00000000-0000-4000-8000-000000000031";
const assigned = {
  status: "matched",
  operationId,
  controllerId,
  version: 1,
  serverNowMs: 1,
  assignment: {
    matchId: operationId,
    roomId: "12345",
    instanceId,
    expiresAtMs: 30000,
    membership: { playerId: ids[0], role: "host", token: token(0) },
  },
};
function harness(
  target: { type: "rated" } | { type: "tournament"; id: number },
  respond: (url: URL, init: RequestInit) => unknown,
  state?: BotState,
) {
  const config = runConfigSchema.parse({
    origin: "https://example.com",
    game: "four-shogi",
    profiles: ["bot1"],
    target,
  });
  const saved = state ?? { scope: scope(config), controllerId };
  const snapshots: BotState[] = [];
  const stop = new StopControl();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe("__Secure-tetraboard-2026.session_token=secret");
    if (url.pathname === "/api/account/session")
      return Response.json({
        user: {
          profileId: ids[0],
          username: "bot1",
          name: "BOT-1",
          avatarUrl: null,
          profileCompleted: true,
          isGuest: false,
        },
      });
    if (url.pathname === "/api/account/legal")
      return Response.json({ accepted: true, version: legalVersion });
    requests.push({
      path: url.pathname,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const value = respond(url, init);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  const api = new Api(
    config.origin,
    { cookie: "secret", identity: ids[0] },
    async () => {},
    fetcher,
  );
  const queue = new Queue(
    api,
    config,
    saved,
    async () => {
      snapshots.push(structuredClone(saved));
    },
    stop,
    () => stop.mode !== "running",
    () => {},
    async () => {},
  );
  return { queue, stop, saved, snapshots, requests };
}

test("レート保存待ち・取得不能の間はjoinせず、解放確認後に参加する", async () => {
  let reads = 0;
  const h = harness({ type: "rated" }, (url, init) => {
    expect(url.searchParams.get("previousMatch")).toBe("1");
    if (init.method === "POST") {
      expect(url.pathname.endsWith("/join")).toBe(true);
      matchmakingInputSchema.parse(JSON.parse(String(init.body)));
      return { ...assigned, operationId: h.saved.operationId };
    }
    reads++;
    return {
      status: "idle",
      enabled: true,
      serverNowMs: 1,
      ...(reads < 3
        ? {
            previousMatch: {
              game: "four-reversi",
              matchId: operationId,
              phase: reads === 1 ? "saving" : "unavailable",
            },
          }
        : {}),
    };
  });
  expect((await h.queue.next())?.roomId).toBe("12345");
  expect(reads).toBe(3);
  expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  expect(h.snapshots.at(-1)?.seat?.token).toBe(token(0));
});

test("Ctrl+Cと成立が競合したレート戦は取消応答の割当を保存して完走へ進む", async () => {
  const h = harness({ type: "rated" }, (_url, init) => {
    if (init.method === "POST") {
      matchmakingControlSchema.parse(JSON.parse(String(init.body)));
      return assigned;
    }
    return { status: "waiting", operationId, controllerId, version: 1, serverNowMs: 1 };
  });
  h.stop.request();
  expect((await h.queue.next())?.playerId).toBe(ids[0]);
  expect(h.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
    "/api/matchmaking/four-shogi/cancel",
  ]);
});

test("joinの応答喪失後は新しい操作IDを発行せず、同じ参加要求を再確認する", async () => {
  const attempts: string[] = [];
  const h = harness({ type: "rated" }, (_url, init) => {
    if (init.method === "POST") {
      const body = matchmakingInputSchema.parse(JSON.parse(String(init.body)));
      attempts.push(body.operationId);
      if (attempts.length === 1) throw Error("network");
      return { ...assigned, operationId: body.operationId };
    }
    return { status: "idle", enabled: true, serverNowMs: 1 };
  });
  await expect(h.queue.next()).rejects.toThrow("network_error");
  expect((await h.queue.next())?.instanceId).toBe(instanceId);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
});

test("保存した操作元でレート割当へ復帰し、別操作元の資格は奪わない", async () => {
  const h = harness({ type: "rated" }, () => assigned, {
    scope: "saved",
    controllerId,
    operationId,
    version: 1,
  });
  expect((await h.queue.next())?.token).toBe(token(0));
  expect(h.requests).toHaveLength(1);
  const other = harness({ type: "rated" }, () => ({
    ...assigned,
    controllerId: crypto.randomUUID(),
  }));
  await expect(other.queue.next()).rejects.toThrow("別の操作元");
  expect(other.requests).toHaveLength(1);
});

test("大会はエントリー・待機・資格取得を経由し、設定を上書きせず入室する", async () => {
  let entered = false,
    queued = false;
  const h = harness({ type: "tournament", id: 7 }, (url, init) => {
    const path = url.pathname;
    if (path.endsWith("/participation"))
      return {
        entered,
        status: queued ? "matched" : "idle",
        controller: queued ? "self" : "none",
        controllerVersion: queued ? 1 : 0,
        ...(queued ? { operationId: h.saved.operationId, roomId: "12345", instanceId } : {}),
      };
    if (path.endsWith("/entries")) {
      expect(new Headers(init.headers).get("X-Legal-Consent")).toBe(legalVersion);
      entered = true;
      return { entered: true };
    }
    if (path.endsWith("/queue")) {
      tournamentQueueInputSchema.parse(JSON.parse(String(init.body)));
      queued = true;
      return { ok: true };
    }
    if (path.endsWith("/controller")) {
      const body = tournamentControllerInputSchema.parse(JSON.parse(String(init.body)));
      expect(body.takeover).toBe(false);
      return {
        participation: {
          entered: true,
          status: "matched",
          controller: "self",
          controllerVersion: 1,
          operationId: h.saved.operationId,
          roomId: "12345",
          instanceId,
        },
        token: token(0),
      };
    }
    if (path.endsWith("/me")) {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token(0)}`);
      return { playerId: ids[0], role: "host" };
    }
    return {
      tournament: {
        id: 7,
        name: "test",
        description: "",
        rulesDescription: "",
        startsAtMs: 0,
        endsAtMs: 999999,
        status: "active",
        entryCount: 0,
        waitingCount: 0,
        playingCount: 0,
        pendingCount: 0,
        completedCount: 0,
        ruleVersion: 2,
        settings: {
          game: "four-shogi",
          mode: "singles",
          timeControl: { mainTimeMs: 0, byoyomiMs: 10000 },
          threePlayerAttackProhibited: false,
        },
        finalizedAtMs: null,
      },
      nextTournament: null,
      standings: [],
      self: null,
      nextCursor: null,
    };
  });
  expect((await h.queue.next())?.playerId).toBe(ids[0]);
  expect(h.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual([
    "/api/tournaments/7/entries",
    "/api/tournaments/7/queue",
    "/api/tournaments/7/controller",
  ]);
});
