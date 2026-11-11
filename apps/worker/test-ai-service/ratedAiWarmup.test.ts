import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { matchmakingQueues, matchmakingStateSchema } from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import { accountFixture, origin } from "../test/accountFixtures";
import { AcceptedGameRequest } from "../test/acceptedGameRequest";

type Coordinator = ReturnType<Env["MATCHMAKING_COORDINATOR"]["getByName"]>;
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));

async function queuePlayer(coordinator: Coordinator) {
  const account = await accountFixture();
  const controllerId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const result = await coordinator.join(account.id, operationId, controllerId);
  expect(result.ok).toBe(true);
  return { account, controllerId, operationId };
}

async function connect(roomId: string, token: string) {
  const upgraded = await request(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
  expect(upgraded.status).toBe(101);
  const socket = upgraded.webSocket!;
  socket.accept();
  const authed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (JSON.parse(String(event.data)).type === "room.authenticated") resolve();
    });
  });
  socket.send(JSON.stringify({ type: "room.auth", token }));
  await authed;
  return socket;
}

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%sのCPU補充局は入室済みでもAIの準備を待ってから開始する",
  async (game) => {
    const rules = matchmakingQueues[game];
    const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const allowed = Promise.withResolvers<void>();
    let endpoint: URL | undefined;
    let ready = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      endpoint = new URL(String(url));
      await allowed.promise;
      return Response.json({ status: "ok" });
    });
    vi.spyOn(console, "info").mockImplementation((entry) => {
      if (entry?.event === "rated_ai_warmup_ready") ready = true;
    });
    const { account, controllerId } = await queuePlayer(coordinator);
    let socket: WebSocket | undefined;
    try {
      now += rules.fillAfterMs;
      await runInDurableObject(coordinator, (instance) => instance.alarm());
      const { assignment } = matchmakingStateSchema.parse(
        await coordinator.status(account.id, controllerId),
      );
      expect(assignment).toBeDefined();
      const stub = env.GAME_ROOM.getByName(assignment!.roomId);
      socket = await connect(assignment!.roomId, assignment!.membership.token);
      await vi.waitFor(() => expect(endpoint?.pathname).toBe("/admin/warmup"));
      expect(endpoint?.searchParams.get("game")).toBe(game);
      now += rules.countdownMs + 1;
      expect(await stub.getRoom()).toMatchObject({ status: "waiting" });
      const roomBefore = await stub.getRoom();
      expect(
        roomBefore && "matchmaking" in roomBefore && roomBefore.matchmaking?.startsAtMs,
      ).toBeUndefined();

      allowed.resolve();
      await vi.waitFor(() => expect(ready).toBe(true));
      const room = await stub.getRoom();
      expect(room).toMatchObject({
        status: "waiting",
        matchmaking: { startsAtMs: now + rules.countdownMs },
      });
      now += rules.countdownMs;
      expect(await stub.getRoom()).toMatchObject({
        status: "playing",
        clock: { turnStartedAt: now },
      });
    } finally {
      allowed.resolve();
      socket?.close();
      vi.restoreAllMocks();
      await coordinator.leaveAccount(account.id);
    }
  },
);

test.each([
  ["four-shogi", false],
  ["four-shogi", true],
  ["four-reversi", false],
  ["shogi", false],
  ["reversi", false],
] as const)(
  "%sのAI準備が2回失敗すると未入室の参加者も元の待機へ戻り枠が空く（旧予約=%s）",
  async (game, legacy) => {
    const rules = matchmakingQueues[game];
    const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const allowed = Promise.withResolvers<void>();
    let failedOnce = false;
    let unavailable = false;
    const fetchAi = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await allowed.promise;
      return new Response(null, { status: 503 });
    });
    vi.spyOn(console, "info").mockImplementation((entry) => {
      if (entry?.event === "rated_ai_warmup_failed" && entry.attempt === 1) failedOnce = true;
      if (entry?.event === "rated_ai_warmup_unavailable") unavailable = true;
    });
    const { account, controllerId, operationId } = await queuePlayer(coordinator);
    try {
      now += rules.fillAfterMs;
      await runInDurableObject(coordinator, (instance) => instance.alarm());
      const { assignment } = await coordinator.status(account.id, controllerId);
      expect(assignment).toBeDefined();
      const stub = env.GAME_ROOM.getByName(assignment!.roomId);
      const originalCapacity = env.CPU_CAPACITY.getByName(game);
      const releaseTarget = legacy ? env.CPU_CAPACITY.getByName("four-reversi") : originalCapacity;
      if (legacy) {
        const reservation = await runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.get<{
            sequence: number;
            instanceId: string;
            roomId: string;
            releaseAtMs: number | null;
          }>("external-cpu-capacity"),
        );
        expect(reservation).toBeDefined();
        expect(await releaseTarget.reserve(assignment!.roomId, reservation!.sequence, 3)).toBe(
          true,
        );
        await originalCapacity.release(assignment!.roomId, reservation!.sequence);
        await runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.put("external-cpu-capacity", { ...reservation, game: "four-reversi" }),
        );
      }
      await stub.getRoom();
      allowed.resolve();
      await vi.waitFor(() => expect(failedOnce).toBe(true));
      now += 1999;
      await runInDurableObject(stub, (instance) => instance.alarm());
      expect(fetchAi).toHaveBeenCalledTimes(1);
      now++;
      await runInDurableObject(stub, (instance) => instance.alarm());
      await vi.waitFor(() => expect(unavailable).toBe(true));
      expect(fetchAi).toHaveBeenCalledTimes(2);
      expect(await stub.getRoom()).toBeNull();

      await runInDurableObject(coordinator, (instance) => instance.alarm());
      expect(await coordinator.status(account.id, controllerId)).toMatchObject({
        status: "waiting",
        operationId,
      });
      expect(
        await env.APP_DB.prepare(
          `SELECT 1 FROM ${game.replaceAll("-", "_")}_rating_pending WHERE account_id=?`,
        )
          .bind(account.id)
          .first(),
      ).toBeNull();
      await vi.waitFor(async () => {
        const active = await runInDurableObject(releaseTarget, (_, ctx) =>
          ctx.storage.kv.get(`active:${assignment!.roomId}`),
        );
        expect(active).toBeUndefined();
      });
    } finally {
      allowed.resolve();
      vi.restoreAllMocks();
      await coordinator.leaveAccount(account.id);
    }
  },
);

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%sの対人レート戦はAIを起動せず開始する",
  async (game) => {
    const rules = matchmakingQueues[game];
    const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchAi = vi.spyOn(globalThis, "fetch");
    const users: Awaited<ReturnType<typeof queuePlayer>>[] = [];
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < rules.seats; i++) users.push(await queuePlayer(coordinator));
      const [first] = users;
      const { assignment } = await coordinator.status(first!.account.id, first!.controllerId);
      expect(assignment).toBeDefined();
      const stub = env.GAME_ROOM.getByName(assignment!.roomId);
      for (const user of users) {
        const state = await coordinator.status(user.account.id, user.controllerId);
        sockets.push(await connect(state.assignment!.roomId, state.assignment!.membership.token));
      }
      now += rules.countdownMs;
      expect(await stub.getRoom()).toMatchObject({ status: "playing" });
      expect(fetchAi).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) socket.close();
      vi.restoreAllMocks();
      for (const user of users) await coordinator.leaveAccount(user.account.id);
    }
  },
);
