import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  fourReversiRatingResultSchema,
  reversiRoomSchema,
  getPublicMatchContract,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/reversi";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { reversiMatchData } from "../src/adapters/record/reversiMatchData";
import { readMatchDetailRecord } from "../src/adapters/record/snapshotMatchStore";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import {
  useMatchmakingFixtures,
  stub,
  fourRatedQueue,
  reversiQueue,
  accounts,
  rooms,
  fixture,
  connect,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

test.each([true, false])(
  "成立済みの四人対局が終了して保存され、レート戦だけ認定が進む rated=%s",
  async (rated) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = rated ? fourRatedQueue() : stub();
    const users = await fixture(4, queue);
    const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
    const a = states[0]!.assignment!;
    rooms.add(a.roomId);
    const roomStub = env.GAME_ROOM.getByName(a.roomId);
    const result = (account = users[0]!.account) =>
      exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/four-reversi/results/${a.matchId}?includeOpponent=1`,
          { headers: account.headers },
        ),
      );
    if (rated) expect(await (await result()).json()).toEqual({ status: "pending" });
    else {
      const status = await exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/four-reversi?controllerId=${users[0]!.controllerId}`,
          { headers: users[0]!.account.headers },
        ),
      );
      expect(await status.json()).toMatchObject({
        enabled: false,
        status: "matched",
        assignment: a,
      });
      expect((await result()).status).toBe(404);
    }
    for (const state of states) await connect(a.roomId, state.assignment!.membership.token);
    expect(await roomStub.getRoom()).toMatchObject({
      status: "waiting",
      matchmaking: { startsAtMs: now + 5000 },
    });
    now += 5000;
    expect(await roomStub.getRoom()).toMatchObject({ status: "playing" });
    const matchStart = await runInDurableObject(roomStub, (_, state) =>
      state.storage.kv.get("match-start"),
    );
    expect(!!(matchStart as { fourReversiRating?: unknown })?.fourReversiRating).toBe(rated);
    for (const state of states.slice(1)) {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(state.assignment!.membership.token),
      );
      expect(
        await roomStub.leaveRoom(
          Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
        ),
      ).toBe("left");
    }
    await vi.waitFor(async () => {
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM matches WHERE id=?").bind(a.matchId).first(),
      ).not.toBeNull();
      if (rated)
        expect(await (await result()).json()).toMatchObject({ status: "placement", games: 1 });
    });
    if (rated) {
      const payload = fourReversiRatingResultSchema.parse(await (await result()).json());
      expect(payload).toEqual({
        status: "placement",
        games: 1,
        players: Object.fromEntries(
          states
            .slice(1)
            .map((state) => [state.assignment!.membership.playerId, { status: "placement" }]),
        ),
      });
      const outsider = await accountFixture();
      accounts.push(outsider.id);
      expect((await result(outsider)).status).toBe(404);
    } else expect((await result()).status).toBe(404);
  },
);

test.each(["human", "random", "engine", "fallback"] as const)(
  "通常リバーシのレート戦を開始・保存する（%s）",
  async (scenario) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = reversiQueue();
    const users = await fixture(scenario === "human" ? 2 : 1, queue);
    const user = users[0]!;
    if (scenario !== "human") {
      now += 14_999;
      await runInDurableObject(queue, (instance) => instance.alarm());
      expect((await queue.status(user.account.id, user.controllerId)).status).toBe("waiting");
      now++;
      await runInDurableObject(queue, (instance) => instance.alarm());
    }
    const assignment = (await queue.status(user.account.id, user.controllerId)).assignment!;
    expect(assignment.opponent).toBe(scenario === "human" ? "human" : "cpu");
    rooms.add(assignment.roomId);
    const room = env.GAME_ROOM.getByName(assignment.roomId);
    const socket = await connect(assignment.roomId, assignment.membership.token);
    if (users[1]) {
      const other = users[1];
      const second = (await queue.status(other.account.id, other.controllerId)).assignment!;
      expect(second.matchId).toBe(assignment.matchId);
      await connect(second.roomId, second.membership.token);
    }
    now += 5000;
    const started = reversiRoomSchema.parse(await room.getRoom());
    if (started.status !== "playing") throw Error("Expected playing");
    expect(started.players.find((player) => player.kind === "cpu")?.name).toBe(
      scenario === "human" ? undefined : "クルリ",
    );
    expect(started.settings.timeControl).toEqual({ mainTimeMs: 300_000, byoyomiMs: 0 });

    if (scenario !== "human") {
      const human = started.players.find((p) => p.id === assignment.membership.playerId)!;
      if (human.color === started.game.turn) {
        socket.send(
          JSON.stringify({
            type: "room.game.action",
            roundId: started.roundId,
            positionRevision: started.positionRevision,
            action: { type: "placeStone", position: getLegalMoves(started.game)[0] },
          }),
        );
      }
      const cpuPly = human.color === "black" ? 1 : 0;
      await vi.waitFor(async () =>
        expect(reversiRoomSchema.parse(await room.getRoom()).game?.moveNumber).toBe(cpuPly),
      );
      const before = reversiRoomSchema.parse(await room.getRoom());
      if (before.status !== "playing") throw Error("Expected playing");
      const aiMove = getLegalMoves(before.game).at(-1)!;
      const fetchAi = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/v1/reversi/move");
        const input = JSON.parse(String(init?.body));
        expect(input.level).toBe(1);
        return scenario === "fallback"
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({
              request_id: input.request_id,
              position_revision: input.position_revision,
              engine_version: "egaroucid-console-7.8.2-0c1b84ef",
              level: input.level,
              position: aiMove,
            });
      });
      vi.spyOn(Math, "random").mockReturnValue(scenario === "random" ? 0.75 : 0.1);
      now = before.clock.turnStartedAt + 2000;
      await runInDurableObject(room, async (instance) => {
        const original = Reflect.get(instance, "env");
        Reflect.set(instance, "env", {
          ...original,
          AI_REVERSI_ENABLED: "true",
          AI_SERVICE_URL: "https://ai.example.test",
          AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
        });
        try {
          await instance.alarm();
          if (scenario !== "random") await instance.alarm();
        } finally {
          Reflect.set(instance, "env", original);
        }
      });
      expect(fetchAi).toHaveBeenCalledTimes(scenario === "random" ? 0 : 1);
      fetchAi.mockRestore();
      const moved = reversiRoomSchema.parse(await room.getRoom()).game;
      expect(moved?.moveNumber).toBe(cpuPly + 1);
      expect(getLegalMoves(before.game)).toContainEqual(moved?.lastMove);
      if (scenario === "engine") expect(moved?.lastMove).toEqual(aiMove);
    }

    const tokenHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(assignment.membership.token),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(await room.leaveRoom(tokenHash)).toBe("left");
    await vi.waitFor(async () => {
      now++;
      await room.getRoom();
      const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
        .bind(assignment.matchId)
        .first<{ record_json: string }>();
      expect(saved).toBeTruthy();
      expect(JSON.parse(saved!.record_json).rating).toMatchObject(
        scenario === "human" ? { kind: "human" } : { kind: "cpu", referenceRating: 1490 },
      );
      const response = await exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/reversi/results/${assignment.matchId}?includeOpponent=1`,
          { headers: user.account.headers },
        ),
      );
      expect(await response.json()).toEqual(
        scenario === "fallback"
          ? { status: "excluded", reason: "ai_fallback" }
          : {
              status: "placement",
              games: 1,
              opponent:
                scenario === "human" ? { status: "placement" } : { status: "cpu", rating: 1490 },
            },
      );
      const changes = await env.APP_DB.prepare(
        "SELECT account_id,rating_after,human_games FROM elo_rating_changes WHERE game='reversi' AND match_id=?",
      )
        .bind(assignment.matchId)
        .all<{ account_id: string; rating_after: number; human_games: number }>();
      expect(changes.results).toHaveLength(scenario === "fallback" ? 0 : users.length);
      if (scenario !== "fallback") {
        const self = changes.results.find((row) => row.account_id === user.account.id)!;
        expect(self.human_games).toBe(scenario === "human" ? 1 : 0);
        expect(self.rating_after).toBeCloseTo(
          scenario === "human" ? 1468 : 1500 - 48 / (1 + 10 ** (-10 / 400)),
        );
      }
      expect(
        await env.APP_DB.prepare(
          "SELECT COUNT(*) AS count FROM elo_rating_pending WHERE game='reversi' AND match_id=?",
        )
          .bind(assignment.matchId)
          .first("count"),
      ).toBe(0);
    });
    const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(assignment.matchId)
      .first<string>("record_json");
    const restored = await readMatchDetailRecord(env.APP_DB, saved!, "reversi");
    const record = reversiMatchData.read(JSON.stringify(restored.record));
    expect(
      record.participants.filter((player) => player.kind === "cpu").map((player) => player.name),
    ).toEqual(scenario === "human" ? [] : ["クルリ"]);
    for (const player of record.participants) {
      const query = new URLSearchParams({
        source: "match",
        matchId: record.id,
        playerId: player.id,
        game: "reversi",
        includeRating: "1",
      });
      const response = await exports.default.fetch(
        new AcceptedGameRequest(`${origin}/api/player-profile?${query}`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        rating:
          player.kind === "cpu"
            ? { timing: "reference", status: "rated", rating: 1490 }
            : { timing: "before", status: "placement" },
      });
    }
    const replay = await exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/matches/${assignment.matchId}`),
    );
    expect(replay.status).toBe(200);
    const { match } = getPublicMatchContract.response.parse(await replay.json());
    expect(
      match.participants.filter((player) => player.kind === "cpu").map((player) => player.name),
    ).toEqual(scenario === "human" ? [] : ["クルリ"]);
    await writeMatch(env.APP_DB, record);
    expect(
      await env.APP_DB.prepare(
        "SELECT COUNT(*) FROM elo_rating_changes WHERE game='reversi' AND match_id=?",
      )
        .bind(assignment.matchId)
        .first("COUNT(*)"),
    ).toBe(scenario === "fallback" ? 0 : users.length);
  },
);
