import { fixTestTime } from "./fixedTimeFixture";
import { humanFixtureRecord, fixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterEach, expect, test } from "vitest";
import worker from "../src/worker";
import { lobbyRoomsSchema } from "@tetraboard/protocol/general-lobby";
import { accountFixture, origin } from "./accountFixtures";
import { writeRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
const db = (env as typeof env & { LOBBY_TEST_DB: D1Database }).LOBBY_TEST_DB;
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  await db.batch(
    [
      "account_match_history",
      "matches",
      "match_event_chunks",
      "match_uploads",
      "session",
      "account",
      "legal_consents",
      "user",
      "deleted_accounts",
      "deletion_rooms",
      "room_index",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});
const request = (path: string, init?: RequestInit, owner?: string) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, init),
    { ...env, APP_DB: db, ADMIN_ACCOUNT_IDS: owner ? JSON.stringify([owner]) : "[]" },
    {} as ExecutionContext,
  );
async function fixture(complete = true) {
  return accountFixture(complete, crypto.randomUUID(), db);
}
test("6ゲームのルームは状態分類・更新日時をサーバーで並べ、定員と20件の境界を守る", async () => {
  for (let i = 0; i < 27; i++) {
    const game = gameIds[i % 6],
      capacity = gameCatalog[game].capacity,
      rank = i % 3,
      status = rank === 2 ? "playing" : "waiting";
    await writeRoomIndex(db, {
      revision: 1,
      closed: false,
      retryAtMs: 0,
      metadata: {
        id: String(10000 + i),
        instanceId: crypto.randomUUID(),
        game,
        ...(gameCatalog[game].hasModes ? { mode: "singles" as const } : {}),
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
        status,
        hostName: "募集者",
        hostAvatarUrl: null,
        humanCount: rank === 0 ? 1 : capacity,
        cpuCount: 0,
        capacity,
        openSeats: rank === 0 ? capacity - 1 : 0,
        updatedAtMs: 1000 + i,
      },
    });
  }
  const firstResponse = await request("/lobby/rooms"),
    first = lobbyRoomsSchema.parse(await firstResponse.json());
  expect(first.rooms).toHaveLength(20);
  expect(new Set(first.rooms.map((r) => r.game)).size).toBe(6);
  expect(first.rooms.slice(0, 9).every((r) => r.status === "waiting" && r.openSeats > 0)).toBe(
    true,
  );
  expect(first.rooms.slice(9, 18).every((r) => r.status === "waiting" && r.openSeats === 0)).toBe(
    true,
  );
  const second = lobbyRoomsSchema.parse(
    await (await request(`/lobby/rooms?cursor=${first.nextCursor}`)).json(),
  );
  expect(second.rooms).toHaveLength(7);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.rooms, ...second.rooms].map((r) => r.id)).size).toBe(27);
  const filtered = lobbyRoomsSchema.parse(await (await request("/lobby/rooms?capacity=2")).json());
  expect(filtered.rooms.every((r) => r.capacity === 2)).toBe(true);
  expect((await request("/lobby/rooms?capacity=3")).status).toBe(400);
});

test("最近の対局はゲーム横断の開始順で最新20件、人間限定は先に絞る", async () => {
  const clock = fixTestTime();
  const loopStartedAtMs = Date.now();
  const user = await fixture();
  const startedAtMs = 1700000000000;
  const ids: string[] = [];
  for (let i = 0; i < 22; i++) {
    const record = fixtureRecord(user.id, i);
    record.startedAtMs = startedAtMs + i;
    ids.push(record.id);
    await writeMatch(db, record);
    // 低速環境で準備中に1秒を超えても、対局の前後関係を変えません。
    clock.mockReturnValue(loopStartedAtMs + (i + 1) * 100);
  }
  const human = humanFixtureRecord(user.id, 100);
  human.startedAtMs = startedAtMs - 1000;
  await writeMatch(db, human);
  const shogi = humanShogiRecord(user.id);
  shogi.record.startedAtMs = startedAtMs - 2000;
  await saveShogiFixture(shogi, db);
  const all = (await (await request("/lobby/matches")).json()) as { matches: { id: string }[] };
  expect(all.matches).toHaveLength(20);
  expect(all.matches.map((m) => m.id)).toEqual(ids.slice(-20).reverse());
  expect(all.matches.some((m) => m.id === human.id)).toBe(false);
  const filtered = (await (await request("/lobby/matches?humanOnly=true")).json()) as {
    matches: { id: string; game: string }[];
  };
  expect(filtered.matches.map((m) => m.id)).toEqual([human.id, shogi.record.id]);
});
