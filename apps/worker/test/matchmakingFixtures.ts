import { resetDurableObjectStorage } from "./durableObjectCleanup";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, vi } from "vitest";
import {
  matchmakingRules as rules,
  fourReversiRatedMatchmakingRules,
  shogiMatchmakingRules,
  reversiMatchmakingRules,
  matchmakingQueues,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { standardShogiRecord, saveStandardShogiFixture } from "./standardShogiFixtures";

export const stub = () => env.MATCHMAKING_COORDINATOR.getByName(rules.key);

export const fourRatedQueue = () =>
  env.MATCHMAKING_COORDINATOR.getByName(fourReversiRatedMatchmakingRules.key);

export const shogiQueue = () => env.MATCHMAKING_COORDINATOR.getByName(shogiMatchmakingRules.key);

export const reversiQueue = () =>
  env.MATCHMAKING_COORDINATOR.getByName(reversiMatchmakingRules.key);

export const accounts: string[] = [];

export const rooms = new Set<string>();

const sockets: WebSocket[] = [];

export async function fixture(count: number, queue = stub()) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const account = await accountFixture();
    accounts.push(account.id);
    users.push({ account, operationId: crypto.randomUUID(), controllerId: crypto.randomUUID() });
  }
  for (const user of users) {
    const result = await queue.join(user.account.id, user.operationId, user.controllerId);
    expect(result.ok).toBe(true);
  }
  return users;
}

export async function ratedAccount(rating: number, ratedGames = 1) {
  const account = await accountFixture();
  accounts.push(account.id);
  const previous = standardShogiRecord(account.id, "win", true);
  await saveStandardShogiFixture(previous);
  await env.APP_DB.prepare("INSERT INTO elo_rating_changes VALUES ('shogi',?,?,1500,?,?,0)")
    .bind(previous.record.id, account.id, rating, ratedGames)
    .run();
  return account;
}

export async function fill() {
  await runInDurableObject(stub(), async (_instance, state) => {
    const current = state.storage.kv.get<{ waiting: { joinedAtMs: number }[] }>("state")!;
    for (const w of current.waiting) w.joinedAtMs = Date.now() - rules.fillAfterMs - 100;
    state.storage.kv.put("state", current);
  });
  await runInDurableObject(stub(), (instance) => instance.alarm());
}

export async function connect(id: string, token: string) {
  const r = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } }),
  );
  expect(r.status).toBe(101);
  const socket = r.webSocket!;
  socket.accept();
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (e) => {
      const v = JSON.parse(String(e.data));
      if (v.type === "room.authenticated") resolve();
      if (v.type === "room.error") reject(Error(v.error));
    });
    socket.send(JSON.stringify({ type: "room.auth", token }));
  });
  return socket;
}

export function useMatchmakingFixtures() {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of sockets.splice(0)) s.close();
    for (const id of rooms) {
      await resetDurableObjectStorage(env.GAME_ROOM.getByName(id));
    }
    rooms.clear();
    const cleanup = accounts
      .splice(0)
      .flatMap((id) =>
        [
          "DELETE FROM elo_rating_pending WHERE game IN ('shogi','reversi') AND account_id=?",
          "DELETE FROM skill_rating_pending WHERE game IN ('four-reversi','four-shogi') AND account_id=?",
          "DELETE FROM tournament_wait_reservations WHERE account_id=?",
          "DELETE FROM matchmaking_wait_reservations WHERE account_id=?",
          "DELETE FROM room_avatar_refs WHERE operation_id IN(SELECT operation_id FROM account_room_seats WHERE account_id=?)",
          "DELETE FROM account_room_seats WHERE account_id=?",
        ].map((sql) => env.APP_DB.prepare(sql).bind(id)),
      );
    for (let start = 0; start < cleanup.length; start += 80)
      await env.APP_DB.batch(cleanup.slice(start, start + 80));
    for (const queue of [
      stub(),
      ...Object.values(matchmakingQueues).map(({ key }) =>
        env.MATCHMAKING_COORDINATOR.getByName(key),
      ),
    ])
      await runInDurableObject(queue, async (_instance, state) => {
        await state.storage.deleteAll();
      });
    for (const game of Object.keys(matchmakingQueues))
      await runInDurableObject(env.CPU_CAPACITY.getByName(game), (_, ctx) =>
        ctx.storage.deleteAll(),
      );
  });
}
