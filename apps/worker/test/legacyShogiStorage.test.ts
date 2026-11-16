import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { createInitialState as createShogiState } from "@tetraboard/shogi";
import {
  createRoomContract,
  fourShogiReplayEventSchema,
  getRoomContract,
  roomSchema,
} from "@tetraboard/protocol";
import legacy from "../../../test-fixtures/matches/shogi-legacy.json";
import { waitingRoomFactories } from "../src/rooms/waitingRoomFactories";
import { ShogiStore } from "../src/rooms/shogiStore";
import { StandardShogiStore } from "../src/rooms/standardShogiStore";
import {
  pendingShogiMatchPrefix,
  pendingStandardShogiMatchPrefix,
  advanceShogiMatchSave,
  readShogiMatchReplayPage,
  type PendingShogiMatch,
  type PendingStandardShogiMatch,
  type ShogiMatchRecord,
} from "../src/rooms/shogiMatchStore";
import { standardShogiRecord } from "./standardShogiFixtures";

const stubs: ReturnType<typeof env.GAME_ROOM.getByName>[] = [];
const ids: string[] = [];
function durableObject() {
  const stub = env.GAME_ROOM.getByName(`legacy-shogi-${crypto.randomUUID()}`);
  stubs.push(stub);
  return stub;
}
afterEach(async () => {
  for (const stub of stubs.splice(0))
    await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
  for (const id of ids.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM match_uploads WHERE id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id),
    ]);
});

function roomFixture(game: "four-shogi" | "shogi", status: "playing" | "waiting") {
  const request = createRoomContract.request.parse({
    game,
    name: "旧ルーム",
    quickPlay: false,
    ...(game === "four-shogi" ? { mode: "singles" } : {}),
  });
  const base = waitingRoomFactories[game]({ code: "12345", name: "旧ルーム", request });
  const record = game === "four-shogi" ? legacy.detail : standardShogiRecord(null).record;
  const { repetitions: _index, ...standard } = createShogiState({ players: record.game.players });
  const initial = game === "four-shogi" ? legacy.checkpoints[0]!.frame.game : standard;
  const sides = Object.keys(initial.players);
  const now = Date.now();
  const current = roomSchema.parse({
    ...base,
    players: base.players.map((player) => ({ ...player, reconnectDeadline: now + 300000 })),
    ...(status === "waiting"
      ? {
          lastRound: {
            roundId: record.id,
            game: { ...record.game, drawProposals: [] },
            players: record.participants.map(({ id, name, side }) => ({ id, name, side })),
            eventCount: record.replay.eventCount,
          },
        }
      : {
          status,
          game: initial,
          roundId: record.id,
          players: Object.entries(initial.players).map(([side, id]) => ({
            id,
            side,
            name: "旧参加者",
            kind: "human",
            avatarUrl: null,
            ready: true,
            reconnectDeadline: now + 300000,
          })),
          clock: {
            remainingMainMs: Object.fromEntries(sides.map((side) => [side, 300000])),
            turnStartedAt: now,
            turnExpiresAt: now + 300000,
          },
        }),
  });
  const stored = JSON.parse(JSON.stringify(current));
  delete (status === "playing" ? stored.game : stored.lastRound.game).drawProposals;
  return { current, stored };
}

for (const game of ["four-shogi", "shogi"] as const)
  for (const status of ["playing", "waiting"] as const) {
    test(`${game} ${status}: KVの旧状態を読み、厳しい応答schemaを満たす`, async () => {
      const stub = durableObject();
      const { current, stored } = roomFixture(game, status);
      expect(roomSchema.safeParse(stored).success).toBe(false);
      await runInDurableObject(stub, async (_, state) => {
        state.storage.kv.put("room", stored);
        state.storage.kv.delete("room-state-version");
        for (const [index, player] of current.players.entries()) {
          const hash = String(index + 1).padStart(64, "0");
          state.storage.kv.put(`player-token:${player.id}`, hash);
          state.storage.kv.put(`membership:${hash}`, {
            playerId: player.id,
            role: index === 0 ? "host" : "player",
          });
        }
        await state.storage.setAlarm(Date.now() + 60000);
      });

      expect(await stub.getShareMetadata(current.instanceId)).toEqual({
        id: current.id,
        instanceId: current.instanceId,
        settings: { game },
      });
      expect(await runInDurableObject(stub, (_, state) => state.storage.kv.get("room"))).toEqual(
        stored,
      );
      const snapshot = getRoomContract.response.parse(await stub.getRoomSnapshot());
      expect(snapshot.room).toEqual(current);
      await runInDurableObject(stub, (_, state) => {
        expect(state.storage.kv.get("room")).toEqual(current);
        expect(state.storage.kv.get("room-state-version")).toBe(1);
      });
    });
  }

for (const game of ["four-shogi", "shogi"] as const) {
  test(`${game}: KVのnullの引分提案は補完せずに拒否する`, async () => {
    const stub = durableObject();
    const { stored } = roomFixture(game, "playing");
    stored.game.drawProposals = null;
    await runInDurableObject(stub, async (_, state) => {
      state.storage.kv.put("room", stored);
      await state.storage.setAlarm(Date.now() + 60000);
    });
    expect(await stub.getShareMetadata(stored.instanceId)).toBeNull();
    expect(
      await runInDurableObject(stub, async (instance) => {
        try {
          await instance.getRoom();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  });
}

function archiveFixture(game: "four-shogi" | "shogi") {
  const four: ShogiMatchRecord = JSON.parse(legacy.recordJson);
  four.id = crypto.randomUUID();
  const fixture =
    game === "four-shogi"
      ? {
          record: four,
          events: legacy.events.map(({ event }) => fourShogiReplayEventSchema.parse(event)),
        }
      : standardShogiRecord(null);
  const record: typeof fixture.record = JSON.parse(JSON.stringify(fixture.record));
  delete (record.game as Partial<typeof record.game>).drawProposals;
  ids.push(record.id);
  return { record, events: fixture.events };
}

async function storeArchive(
  stub: ReturnType<typeof durableObject>,
  fixture: ReturnType<typeof archiveFixture>,
  phase: "upload" | "verify",
) {
  const { record, events } = fixture;
  const prefix = record.settings.game === "shogi" ? "standard_shogi" : "shogi";
  const key =
    (record.settings.game === "shogi" ? pendingStandardShogiMatchPrefix : pendingShogiMatchPrefix) +
    record.id;
  await runInDurableObject(stub, async (_, state) => {
    if (record.settings.game === "shogi") new StandardShogiStore(state.storage.sql);
    else new ShogiStore(state.storage.sql);
    state.storage.sql.exec(
      `INSERT INTO ${prefix}_rounds VALUES(?,?,?)`,
      record.id,
      JSON.stringify(record.replay.initial),
      events.length,
    );
    for (const [index, event] of events.entries())
      state.storage.sql.exec(
        `INSERT INTO ${prefix}_events VALUES(?,?,?)`,
        record.id,
        index,
        JSON.stringify(event),
      );
    state.storage.sql.exec(`INSERT INTO ${prefix}_archives VALUES(?)`, record.id);
    state.storage.kv.put(key, {
      record,
      progress: { phase, cursor: 0 },
      retryAtMs: Date.now() + 60000,
    });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  return { key, prefix };
}

async function resumeArchive(stub: ReturnType<typeof durableObject>, key: string) {
  for (let pass = 0; pass < 3; pass++) {
    await runInDurableObject(stub, async (_, state) => {
      const job = state.storage.kv.get<PendingShogiMatch | PendingStandardShogiMatch>(key);
      if (job) state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60000);
    });
    await runDurableObjectAlarm(stub);
  }
}

for (const game of ["four-shogi", "shogi"] as const)
  for (const scenario of [
    { name: "旧DO・manifestなし", manifest: false, current: false },
    { name: "旧DO・旧manifest", manifest: true, current: false },
    { name: "現行DO・旧manifest", manifest: true, current: true },
  ]) {
    test(`${game}: ${scenario.name}のアーカイブ保存を完了する`, async () => {
      const stub = durableObject();
      const fixture = archiveFixture(game);
      const { record, events } = fixture;
      const original = JSON.stringify(record);
      const pendingRecord: typeof record = JSON.parse(original);
      if (scenario.current) pendingRecord.game.drawProposals = [];
      const pending = { ...fixture, record: pendingRecord };
      const { key, prefix } = await storeArchive(
        stub,
        pending,
        scenario.manifest ? "verify" : "upload",
      );
      if (scenario.manifest) {
        await env.APP_DB.prepare("INSERT INTO match_uploads VALUES(?,?,?,?)")
          .bind(record.id, original, events.length, Math.ceil(events.length / 100))
          .run();
        for (let cursor = 0; cursor < events.length; cursor += 100) {
          const chunk = events.slice(cursor, cursor + 100);
          await env.APP_DB.prepare("INSERT INTO match_event_chunks VALUES(?,?,?,?,?)")
            .bind(record.id, cursor / 100, cursor, chunk.length, JSON.stringify(chunk))
            .run();
        }
      }

      await resumeArchive(stub, key);

      await vi.waitFor(async () => {
        const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
          .bind(record.id)
          .first<string>("record_json");
        expect(saved).not.toBeNull();
        expect(JSON.parse(saved!)).toEqual({
          ...record,
          game: { ...record.game, drawProposals: [] },
        });
        expect(
          await env.APP_DB.prepare("SELECT id FROM match_uploads WHERE id=?")
            .bind(record.id)
            .first(),
        ).toBeNull();
        expect(
          await runInDurableObject(stub, (_, state) => ({
            pending: state.storage.kv.get(key),
            archives: state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${prefix}_archives`).one(),
            events: state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${prefix}_events`).one(),
          })),
        ).toEqual({ pending: undefined, archives: { n: 0 }, events: { n: 0 } });
      });
      const replay = await readShogiMatchReplayPage(env.APP_DB, record.id, 0, game);
      expect(replay?.events.map(({ event }) => event)).toEqual(events.slice(0, 100));
      expect(JSON.stringify(record)).toBe(original);
    });
  }

test("旧manifestでも引分提案以外が異なる再送は拒否し、元のmanifestを保持する", async () => {
  const { record, events } = archiveFixture("four-shogi");
  const json = JSON.stringify({ ...record, endedAtMs: record.endedAtMs + 1 });
  await env.APP_DB.prepare("INSERT INTO match_uploads VALUES(?,?,?,?)")
    .bind(record.id, json, events.length, Math.ceil(events.length / 100))
    .run();

  await expect(
    advanceShogiMatchSave(env.APP_DB, record, { phase: "upload", cursor: 0 }, (cursor) =>
      events.slice(cursor, cursor + 100),
    ),
  ).rejects.toThrow("Conflicting Shogi match upload");

  expect(
    await env.APP_DB.prepare("SELECT record_json FROM match_uploads WHERE id=?")
      .bind(record.id)
      .first("record_json"),
  ).toBe(json);
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(record.id).first(),
  ).toBeNull();
});
