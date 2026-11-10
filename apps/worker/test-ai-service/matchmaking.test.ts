import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourReversiRoomSchema,
  fourReversiRatedMatchmakingRules as rules,
  matchmakingStateSchema,
} from "@tetraboard/protocol";
import { applyAction, createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { accountFixture, origin } from "../test/accountFixtures";
import { AcceptedGameRequest } from "../test/acceptedGameRequest";
import { fourReversiCpuJobKey, type FourReversiCpuJob } from "../src/rooms/fourReversiProgress";
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));

test("実Serviceのヨミ3席と3分切れ負けで完走し、人間の投了後も同じprofileで進行・保存する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const account = await accountFixture(),
    operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  const coordinator = env.MATCHMAKING_COORDINATOR.getByName(rules.key);
  let socket: WebSocket | undefined, roomId: string | undefined, token: string | undefined;
  try {
    const joined = await request("/matchmaking/four-reversi/join?rated=1", {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ operationId, controllerId }),
    });
    expect(joined.status).toBe(200);
    let state = matchmakingStateSchema.parse(await joined.json());
    expect(state.status).toBe("waiting");
    const joinedAt = now;
    now += 10_000;
    const heartbeat = await request("/matchmaking/four-reversi/heartbeat?rated=1", {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ operationId, controllerId, version: 1 }),
    });
    expect(heartbeat.status).toBe(200);
    now = joinedAt + 19_999;
    expect((await coordinator.status(account.id, controllerId)).status).toBe("waiting");
    now = joinedAt + rules.fillAfterMs;
    await runInDurableObject(coordinator, (instance) => instance.alarm());
    state = await coordinator.status(account.id, controllerId);
    expect(state.status).toBe("matched");
    const assigned = state.assignment!;
    roomId = assigned.roomId;
    token = assigned.membership.token;
    const stub = env.GAME_ROOM.getByName(roomId);
    const upgraded = await request(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
    expect(upgraded.status).toBe(101);
    socket = upgraded.webSocket!;
    socket.accept();
    const listeners: { type: string; resolve: () => void; test: (data: any) => boolean }[] = [];
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      for (const listener of [...listeners])
        if (data.type === listener.type && listener.test(data)) {
          listeners.splice(listeners.indexOf(listener), 1);
          listener.resolve();
        }
    });
    const wait = (type: string, test: (data: any) => boolean = () => true) =>
      new Promise<void>((resolve) => listeners.push({ type, resolve, test }));
    let pending = wait("room.authenticated");
    socket.send(JSON.stringify({ type: "room.auth", token }));
    await pending;
    let room = fourReversiRoomSchema.parse(await stub.getRoom());
    expect(room.status).toBe("waiting");
    expect(room.matchmaking?.startsAtMs).toBe(now + 5000);
    now += 5000;
    room = fourReversiRoomSchema.parse(await stub.getRoom());
    expect(room.status).toBe("playing");
    let resigned = false,
      afterElimination = 0,
      cpuMoves = 0;
    for (let step = 0; step < 60; step++) {
      room = fourReversiRoomSchema.parse(await stub.getRoom());
      if (room.status !== "playing") break;
      const turn = room.game.turn;
      const player = room.players.find((p) => p.color === turn)!;
      if (player.kind === "human") {
        pending = wait(
          "room.snapshot",
          (m) => m.room.status !== "playing" || m.room.game.eliminatedColors.length > 0,
        );
        socket.send(JSON.stringify({ type: "room.game.resign" }));
        await pending;
        resigned = true;
      } else {
        now = room.clock.turnStartedAt + 2000;
        await runInDurableObject(stub, (instance) => instance.alarm());
        const job = await runInDurableObject(stub, (_, context) =>
          context.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey),
        );
        expect(job?.source).toBe("external");
        expect(job?.extendedRules).toBe(true);
        expect(job?.serviceProfile).toEqual(
          expect.objectContaining({ profile_id: "lv3-v1", engine_version: "0.2.0" }),
        );
        if (resigned) afterElimination++;
        if (cpuMoves === 3) await evictDurableObject(stub, { webSockets: "hibernate" });
        now++;
        await runInDurableObject(stub, (instance) => instance.alarm());
        cpuMoves++;
      }
    }
    room = fourReversiRoomSchema.parse(await stub.getRoom());
    expect(room.status).toBe("waiting");
    expect(resigned).toBe(true);
    expect(afterElimination).toBeGreaterThan(0);
    const replay = room.lastRound!.replay!;
    expect(replay.id).toBe(assigned.matchId);
    let game = createInitialState("singles");
    for (const entry of replay.steps) {
      const result =
        entry.action.type === "eliminate"
          ? eliminateColor(game, entry.action.color)
          : applyAction(game, { type: "placeStone", position: entry.action.position });
      if (!result.ok) throw Error("棋譜の不正な遷移です");
      expect(result.state).toEqual(entry.game);
      game = result.state;
    }
    expect(game.status).toBe("finished");
    const stored = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(replay.id)
      .first<{ record_json: string }>();
    expect(stored).not.toBeNull();
    const record = JSON.parse(stored!.record_json);
    const cpus = record.participants.filter((p: any) => p.kind === "cpu");
    expect(cpus).toHaveLength(3);
    expect(cpus.map((p: any) => p.name)).toEqual(["ヨミ1", "ヨミ2", "ヨミ3"]);
    for (const p of cpus) {
      expect(p.cpuProfile.level).toBe(3);
      expect(p.cpuProfile.engineVersion).toBe("0.2.0");
    }
    const summary = await request("/matchmaking/four-reversi/rating", { headers: account.headers });
    expect(await summary.json()).toEqual({ status: "placement", games: 1 });
    const result = await request(
      `/matchmaking/four-reversi/results/${replay.id}?includeOpponent=1`,
      { headers: account.headers },
    );
    expect(await result.json()).toEqual({
      status: "placement",
      games: 1,
      players: Object.fromEntries(
        cpus.map((cpu: { id: string }) => [cpu.id, { status: "cpu", rating: 1500 }]),
      ),
    });
    expect(room.settings.timeControl).toEqual({ mainTimeMs: 180000, byoyomiMs: 0 });
  } finally {
    vi.restoreAllMocks();
    socket?.close();
    if (roomId && token) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      await env.GAME_ROOM.getByName(roomId).leaveRoom(
        Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
      );
    }
    await coordinator.leaveAccount(account.id);
  }
}, 30000);
