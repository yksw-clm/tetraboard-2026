import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBots } from "../src/bot";
import { runConfigSchema, scope } from "../src/config";
import { Store, type BotState } from "../src/store";
import { StopControl } from "../src/session";
import { ids, instanceId, token } from "./fixtures";

const operationId = "00000000-0000-4000-8000-000000000030";
const controllerId = "00000000-0000-4000-8000-000000000031";
const seat = { roomId: "12345", instanceId, playerId: ids[0], token: token(0) };
const idle = { status: "idle", serverNowMs: 1 };
const waiting = { status: "waiting", serverNowMs: 1, operationId, controllerId, version: 1 };
const assigned = {
  ...waiting,
  status: "matched",
  assignment: {
    matchId: operationId,
    roomId: seat.roomId,
    instanceId,
    expiresAtMs: 30000,
    membership: { playerId: ids[0], role: "host", token: seat.token },
  },
};
const participation = {
  entered: true,
  status: "idle",
  controller: "none",
  controllerVersion: 0,
};
const configFor = (game: "four-shogi" | "four-reversi", target: unknown) =>
  runConfigSchema.parse({ origin: "https://example.com", game, profiles: ["ota"], target });
const previous = configFor("four-shogi", { type: "rated" });
const next = configFor("four-reversi", { type: "tournament", id: 7 });
const saved = (): BotState => ({ scope: scope(previous), controllerId, operationId, version: 1 });

async function harness(
  state: BotState,
  respond: (url: URL, init: RequestInit) => unknown,
  config = next,
  replace = true,
  stop = new StopControl(),
  authenticated = () => true,
) {
  const home = await mkdtemp(join(tmpdir(), "tb78-replace-"));
  const store = new Store(config.origin, "ota", home);
  const requests: string[] = [];
  const fetcher = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/account/session")
      return Response.json({
        user: authenticated()
          ? {
              profileId: ids[0],
              username: "ota",
              name: "BOT-ota",
              avatarUrl: null,
              profileCompleted: true,
              isGuest: false,
            }
          : null,
      });
    if (url.pathname === "/api/account/legal")
      return Response.json({ accepted: true, version: "2026-11-11" });
    requests.push(`${init.method} ${url.pathname}`);
    const value = respond(url, init);
    return value instanceof Response ? value : Response.json(value);
  };
  try {
    await store.saveProfile({ cookie: "test-cookie", identity: ids[0] });
    await store.saveState(state);
    let error: unknown;
    try {
      await runBots(config, stop, {
        home,
        replace,
        fetcher,
        analysis: () => ({
          watch: async () => {
            throw Error("AI must not start");
          },
          close: async () => {},
        }),
        log: () => () => {},
      });
    } catch (caught) {
      error = caught;
    }
    return { state: await store.loadState(), error, requests };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function newTournament(url: URL, stop: StopControl, finished = false) {
  if (url.pathname === "/api/tournaments/7/participation") {
    stop.request();
    return participation;
  }
  if (url.pathname === "/api/tournaments/7")
    return {
      tournament: {
        id: 7,
        name: "test",
        description: "",
        rulesDescription: "",
        startsAtMs: 0,
        endsAtMs: 999999,
        status: finished ? "finished" : "active",
        entryCount: 0,
        waitingCount: 0,
        playingCount: 0,
        pendingCount: 0,
        completedCount: 0,
        ruleVersion: 2,
        settings: {
          game: "four-reversi",
          mode: "singles",
          timeControl: { mainTimeMs: 0, byoyomiMs: 10000 },
        },
        finalizedAtMs: null,
      },
      nextTournament: null,
      standings: [],
      self: null,
      nextCursor: null,
    };
  throw Error(`Unexpected path: ${url.pathname}`);
}

test("実CLIの--replaceで停止済みの旧レート設定から別ゲームの大会へ切り替わる", async () => {
  const home = await mkdtemp(join(tmpdir(), "tb78-cli-replace-"));
  const requests: string[] = [];
  let previousChecked = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/account/session")
        return Response.json({
          user: {
            profileId: ids[0],
            username: "ota",
            name: "BOT-ota",
            avatarUrl: null,
            profileCompleted: true,
            isGuest: false,
          },
        });
      if (url.pathname === "/api/account/legal")
        return Response.json({ accepted: true, version: "2026-11-11" });
      if (url.pathname === "/api/matchmaking/four-shogi") {
        previousChecked = true;
        return Response.json(idle);
      }
      expect(previousChecked).toBe(true);
      return Response.json(newTournament(url, new StopControl(), true));
    },
  });
  try {
    const store = new Store(server.url.origin, "ota", home);
    await store.saveProfile({ cookie: "test-cookie", identity: ids[0] });
    await store.saveState(saved());
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.ts", import.meta.url).pathname,
        "run",
        "--origin",
        server.url.origin,
        "--game",
        "four-reversi",
        "--bot",
        "ota",
        "--tournament",
        "7",
        "--replace",
      ],
      {
        env: { ...process.env, TETRABOARD_BOT_HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"event":"replaced"');
    expect(stdout).not.toContain("test-cookie");
    expect((await store.loadState())?.scope).toBe(scope(next));
    expect(requests.every((r) => r.startsWith("GET"))).toBe(true);
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

for (const race of [false, true]) {
  test(`レート待機から別ゲームの大会へ切替え、取消と成立の競合=${race}でも解放前に参加しない`, async () => {
    const stop = new StopControl();
    let cancelled = false,
      released = false,
      checked = false;
    const result = await harness(
      saved(),
      (url, init) => {
        if (url.pathname === "/api/matchmaking/four-shogi") {
          expect(url.searchParams.get("previousMatch")).toBe("1");
          if (cancelled && (!race || released)) {
            checked = true;
            return idle;
          }
          return waiting;
        }
        if (url.pathname.endsWith("/cancel")) {
          cancelled = true;
          expect(JSON.parse(String(init.body))).toMatchObject({
            operationId,
            controllerId,
            version: 1,
          });
          return race ? assigned : idle;
        }
        if (url.pathname.endsWith("/leave")) {
          expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${seat.token}`);
          released = true;
          return new Response(null, { status: 204 });
        }
        expect(checked).toBe(true);
        expect(cancelled).toBe(true);
        return newTournament(url, stop);
      },
      next,
      true,
      stop,
    );
    expect(result.error).toBeUndefined();
    expect(result.state?.scope).toBe(scope(next));
    expect(result.state?.operationId).toBeUndefined();
    expect(result.state?.seat).toBeUndefined();
    expect(result.requests.filter((r) => r.startsWith("POST /api/tournaments"))).toEqual([]);
  });
}

test("停止済みレート戦の古い操作情報だけが残っていても切り替えられる", async () => {
  const stop = new StopControl();
  const result = await harness(
    saved(),
    (url) => (url.pathname === "/api/matchmaking/four-shogi" ? idle : newTournament(url, stop)),
    next,
    true,
    stop,
  );
  expect(result.error).toBeUndefined();
  expect(result.state?.scope).toBe(scope(next));
  expect(result.requests.some((r) => r.startsWith("POST"))).toBe(false);
});

test("レート退出の応答喪失で古い席資格が残っても、サーバーで終了を確認して整理する", async () => {
  const stop = new StopControl();
  const result = await harness(
    { ...saved(), seat },
    (url) => {
      if (url.pathname === "/api/matchmaking/four-shogi") return idle;
      if (url.pathname.endsWith("/leave")) return new Response(null, { status: 401 });
      return newTournament(url, stop);
    },
    next,
    true,
    stop,
  );
  expect(result.error).toBeUndefined();
  expect(result.state?.scope).toBe(scope(next));
  expect(result.state?.seat).toBeUndefined();
  expect(result.requests.some((r) => r.endsWith("/leave"))).toBe(false);
});

test("起動確認後にCookieが失効してidleが返っても、復帰できる部屋資格を破棄しない", async () => {
  let expired = false;
  const state = { ...saved(), seat };
  const result = await harness(
    state,
    (url) => {
      if (url.pathname !== "/api/matchmaking/four-shogi")
        return new Response(null, { status: 500 });
      expired = true;
      return idle;
    },
    next,
    true,
    new StopControl(),
    () => !expired,
  );
  expect(result.error).toBeInstanceOf(Error);
  expect(result.state).toEqual(state);
  expect(result.requests).toEqual(["GET /api/matchmaking/four-shogi"]);
});

test("即停止の解放確認中にCookieが失効しても操作情報を破棄しない", async () => {
  let reads = 0;
  let expired = false;
  const stop = new StopControl();
  stop.mode = "force";
  const result = await harness(
    saved(),
    () => {
      reads++;
      if (reads > 1) expired = true;
      return reads === 1
        ? { ...idle, previousMatch: { game: "four-shogi", matchId: operationId, phase: "saving" } }
        : idle;
    },
    previous,
    false,
    stop,
    () => !expired,
  );
  expect(result.error).toBeUndefined();
  expect(result.state).toEqual(saved());
});

for (const phase of ["matched", "playing", "saving", "unavailable"]) {
  test(`レートの前回対局が${phase}の間は保存情報を保持し、新しい参加先へ通信しない`, async () => {
    const result = await harness(saved(), () => ({
      ...idle,
      previousMatch: { game: "four-shogi", matchId: operationId, phase },
    }));
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain("席解放・結果保存");
    expect(result.state?.scope).toBe(scope(previous));
    expect(result.state?.operationId).toBe(operationId);
    expect(result.requests.every((r) => r === "GET /api/matchmaking/four-shogi")).toBe(true);
  });
}

for (const failure of ["read", "cancel", "leave", "other-controller"]) {
  test(`${failure}の失敗で前回の資格を捨てず、新しい参加先へ要求しない`, async () => {
    const result = await harness(saved(), (url) => {
      if (failure === "read") throw Error("offline");
      if (url.pathname.endsWith("/cancel"))
        return failure === "cancel" ? new Response(null, { status: 503 }) : assigned;
      if (url.pathname.endsWith("/leave")) return new Response(null, { status: 503 });
      return { ...waiting, ...(failure === "other-controller" ? { controllerId: ids[3] } : {}) };
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.state?.scope).toBe(scope(previous));
    expect(result.state?.operationId).toBe(operationId);
    if (failure === "leave") expect(result.state?.seat).toEqual(seat);
    expect(result.requests.some((r) => r.includes("/tournaments/"))).toBe(false);
  });
}

test("--replaceなしの切替と、通常入室の結果不明状態の上書きを拒否する", async () => {
  for (const [state, replace] of [
    [saved(), false],
    [{ ...saved(), uncertain: true }, true],
  ] as const) {
    const result = await harness(
      state,
      () => {
        throw Error("must not request");
      },
      next,
      replace,
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.state).toEqual(state);
    expect(result.requests).toEqual([]);
  }
});

test("通常ルームの資格で退出してから大会へ切り替える", async () => {
  const stop = new StopControl();
  const room = configFor("four-shogi", { type: "room", roomId: "12345" });
  let left = false;
  const result = await harness(
    { scope: scope(room), controllerId, seat },
    (url, init) => {
      if (url.pathname.endsWith("/leave")) {
        expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${seat.token}`);
        left = true;
        return new Response(null, { status: 204 });
      }
      expect(left).toBe(true);
      return newTournament(url, stop);
    },
    next,
    true,
    stop,
  );
  expect(result.error).toBeUndefined();
  expect(result.state?.scope).toBe(scope(next));
});

for (const status of ["waiting", "matched", "playing", "race", "race-success"] as const) {
  test(`大会の${status}からレートへ切替え、引継ぎは自分の操作元に限定する`, async () => {
    const stop = new StopControl();
    const tournament = configFor("four-shogi", { type: "tournament", id: 6 });
    const rated = configFor("four-reversi", { type: "rated" });
    let released = false,
      raced = false;
    const result = await harness(
      { ...saved(), scope: scope(tournament) },
      (url, init) => {
        if (url.pathname === "/api/tournaments/6/participation")
          return released
            ? participation
            : {
                entered: true,
                status:
                  status === "race" || status === "race-success"
                    ? raced
                      ? "playing"
                      : "waiting"
                    : status,
                controller: "self",
                controllerVersion: 1,
                operationId,
                roomId: seat.roomId,
                instanceId,
              };
        if (url.pathname === "/api/tournaments/6/queue") {
          expect(init.method).toBe("DELETE");
          expect(JSON.parse(String(init.body))).toMatchObject({
            operationId,
            controllerId,
            controllerVersion: 1,
          });
          if (status === "race" || status === "race-success") {
            raced = true;
            return status === "race" ? new Response(null, { status: 409 }) : { ok: true };
          }
          released = true;
          return { ok: true };
        }
        if (url.pathname === "/api/tournaments/6/controller") {
          expect(JSON.parse(String(init.body))).toMatchObject({ takeover: false, controllerId });
          return {
            participation: {
              entered: true,
              status: "playing",
              controller: "self",
              controllerVersion: 1,
              operationId,
              roomId: seat.roomId,
              instanceId,
            },
            token: seat.token,
          };
        }
        if (url.pathname.endsWith("/me")) return { playerId: ids[0], role: "host" };
        if (url.pathname.endsWith("/leave")) {
          expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${seat.token}`);
          released = true;
          return new Response(null, { status: 204 });
        }
        expect(url.pathname).toBe("/api/matchmaking/four-reversi");
        expect(init.method).toBe("GET");
        expect(released).toBe(true);
        stop.request();
        return idle;
      },
      rated,
      true,
      stop,
    );
    expect(result.error).toBeUndefined();
    expect(result.state?.scope).toBe(scope(rated));
    expect(result.state?.operationId).toBeUndefined();
    expect(result.state?.seat).toBeUndefined();
  });
}

test("他の操作元が使用中の大会は取り消さず、前回設定を保持する", async () => {
  const tournament = configFor("four-shogi", { type: "tournament", id: 6 });
  const state = { ...saved(), scope: scope(tournament) };
  const result = await harness(state, (_url, init) => {
    expect(init.method).toBe("GET");
    return {
      ...participation,
      status: "waiting",
      controller: "other",
      controllerVersion: 2,
      operationId,
    };
  });
  expect(String(result.error)).toContain("別の操作元");
  expect(result.state).toEqual(state);
  expect(result.requests).toEqual(["GET /api/tournaments/6/participation"]);
});

for (const mode of ["drain", "force"] as const) {
  test(`${mode}停止はレート待機の取消確認後に操作情報を保存から除く`, async () => {
    const stop = new StopControl();
    stop.mode = mode;
    let cancelled = false;
    const result = await harness(
      saved(),
      (url) => {
        if (url.pathname.endsWith("/cancel")) {
          cancelled = true;
          return idle;
        }
        return cancelled ? idle : waiting;
      },
      previous,
      false,
      stop,
    );
    expect(result.error).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(result.state).toEqual({ scope: scope(previous), controllerId });
  });
}

test("即停止でも取消確認ができない場合や結果保存待ちなら復帰情報を残す", async () => {
  for (const unavailable of [false, true]) {
    const stop = new StopControl();
    stop.mode = "force";
    const result = await harness(
      saved(),
      () => {
        if (unavailable) throw Error("offline");
        return {
          ...idle,
          previousMatch: { game: "four-shogi", matchId: operationId, phase: "saving" },
        };
      },
      previous,
      false,
      stop,
    );
    expect(result.error).toBeUndefined();
    expect(result.state).toEqual(saved());
  }
});
