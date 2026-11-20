import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { matchmakingStateSchema, matchmakingQueues } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { recordUsageEvents } from "./usageEventsRecorder";
import {
  useMatchmakingFixtures,
  shogiQueue,
  accounts,
  rooms,
  fixture,
  connect,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

test.each(["shogi", "reversi"] as const)("%sの保存待ちも全ゲームの再検索を止める", async (game) => {
  const account = await accountFixture();
  accounts.push(account.id);
  const table = "elo_rating_pending";
  await env.APP_DB.prepare(`INSERT INTO ${table}(game,account_id,match_id) VALUES ('${game}',?,?)`)
    .bind(account.id, crypto.randomUUID())
    .run();
  for (const target of Object.keys(matchmakingQueues) as (keyof typeof matchmakingQueues)[])
    expect(
      await env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[target].key).join(
        account.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    ).toMatchObject({ ok: false });
});

test("前局の保存待ちがある古い待機者も、成立処理で待機列から外す", async () => {
  const usage = recordUsageEvents();
  const queue = shogiQueue();
  const [user] = await fixture(1, queue);
  await env.APP_DB.prepare(
    "INSERT INTO skill_rating_pending(game,account_id,match_id) VALUES ('four-reversi',?,?)",
  )
    .bind(user!.account.id, crypto.randomUUID())
    .run();
  await runInDurableObject(queue, (instance) => instance.alarm());
  expect((await queue.status(user!.account.id, user!.controllerId)).status).toBe("idle");
  expect((await queue.status(null)).waitingCount).toBe(4);
  await runInDurableObject(shogiQueue(), (instance) => instance.alarm());
  expect(
    usage
      .filter((e) => e.name === "matchmaking")
      .filter((e) => e.operationId === user!.operationId)
      .filter((e) => e.stage === "failed"),
  ).toEqual([expect.objectContaining({ reason: "invalidated" })]);
});

test.each(["four-reversi", "four-shogi"] as const)(
  "%sの脱落・退室後も別ゲームを含む再検索を止め、本人だけに観戦先を返し、保存後に解除する",
  async (game) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const users = await fixture(4, queue);
    const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
    const assignment = states[0]!.assignment!;
    rooms.add(assignment.roomId);
    const room = env.GAME_ROOM.getByName(assignment.roomId);
    for (const state of states)
      await connect(assignment.roomId, state.assignment!.membership.token);
    now += 5000;
    expect(await room.getRoom()).toMatchObject({ status: "playing" });
    const leave = async (index: number) => {
      const token = states[index]!.assignment!.membership.token;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      );
      expect(await room.leaveRoom(hash)).toBe("left");
    };
    await leave(0);
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
          .bind(users[0]!.account.id)
          .first(),
      ).toBeNull(),
    );
    const table = "skill_rating_pending";
    expect(
      await env.APP_DB.prepare(
        `SELECT room_id,instance_id FROM ${table} WHERE game='${game}' AND account_id=?`,
      )
        .bind(users[0]!.account.id)
        .first(),
    ).toEqual({ room_id: assignment.roomId, instance_id: assignment.instanceId });
    const status = async (target: keyof typeof matchmakingQueues, account = users[0]!.account) => {
      const response = await exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/${target}?rated=1&previousMatch=1&controllerId=${crypto.randomUUID()}`,
          { headers: account.headers },
        ),
      );
      expect(response.status).toBe(200);
      return matchmakingStateSchema.parse(await response.json());
    };
    // DO再起動後も、退室時に解放される席ではなくレート保存待ちの参照を使います。
    await evictDurableObject(queue);
    const withoutOptIn = await exports.default.fetch(
      new AcceptedGameRequest(
        `${origin}/api/matchmaking/shogi?controllerId=${crypto.randomUUID()}`,
        { headers: users[0]!.account.headers },
      ),
    );
    expect(
      ((await withoutOptIn.json()) as { previousMatch?: unknown }).previousMatch,
    ).toBeUndefined();
    for (const target of Object.keys(matchmakingQueues) as (keyof typeof matchmakingQueues)[]) {
      const data = await status(target);
      expect(data.status).toBe("idle");
      expect(data.previousMatch).toMatchObject({
        game,
        matchId: assignment.matchId,
        phase: "playing",
        room: {
          id: assignment.roomId,
          instanceId: assignment.instanceId,
          matchSequence: expect.any(Number),
        },
      });
      expect(JSON.stringify(data.previousMatch)).not.toContain("token");
      expect(
        await env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[target].key).join(
          users[0]!.account.id,
          crypto.randomUUID(),
          crypto.randomUUID(),
        ),
      ).toMatchObject({ ok: false, message: expect.stringContaining("保存中") });
    }
    const other = await accountFixture();
    expect(await status(game, users[1]!.account)).toMatchObject({
      status: "playing",
      previousMatch: { phase: "playing", game },
    });
    accounts.push(other.id);
    expect((await status("shogi", other)).previousMatch).toBeUndefined();
    await env.APP_DB.prepare(`UPDATE ${table} SET room_id=NULL,instance_id=NULL WHERE account_id=?`)
      .bind(users[0]!.account.id)
      .run();
    expect((await status("shogi")).previousMatch).toMatchObject({
      phase: "playing",
      room: { id: assignment.roomId },
    });
    await env.APP_DB.prepare(`UPDATE ${table} SET room_id=?,instance_id=? WHERE account_id=?`)
      .bind(assignment.roomId, assignment.instanceId, users[0]!.account.id)
      .run();
    await env.APP_DB.prepare(`UPDATE ${table} SET instance_id=? WHERE account_id=?`)
      .bind(crypto.randomUUID(), users[0]!.account.id)
      .run();
    expect((await status("shogi")).previousMatch).toMatchObject({ phase: "saving" });
    expect((await status("shogi")).previousMatch?.room).toBeUndefined();
    await env.APP_DB.prepare(`UPDATE ${table} SET instance_id=? WHERE account_id=?`)
      .bind(assignment.instanceId, users[0]!.account.id)
      .run();
    await leave(1);
    await leave(2);
    await vi.waitFor(
      async () => {
        now += 1;
        await runInDurableObject(room, async (instance) => {
          await instance.alarm();
          const runtime = Reflect.get(
            instance,
            "runtime",
          ) as import("../src/durableObjects/gameRoom/runtime").RoomRuntime;
          await Promise.all([runtime.jobs.matchJob.running, runtime.jobs.shogiMatchJob.running]);
        });
        expect(
          await env.APP_DB.prepare(`SELECT 1 FROM ${table} WHERE game='${game}' AND account_id=?`)
            .bind(users[0]!.account.id)
            .first(),
        ).toBeNull();
      },
      { interval: 1 },
    );
    for (const target of Object.keys(matchmakingQueues) as (keyof typeof matchmakingQueues)[])
      expect((await status(target)).previousMatch).toBeUndefined();
    expect(
      await shogiQueue().join(users[0]!.account.id, crypto.randomUUID(), crypto.randomUUID()),
    ).toMatchObject({ ok: true, state: { status: "waiting" } });
  },
);
