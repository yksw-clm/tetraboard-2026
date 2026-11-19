import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { createInitialState as createShogiState } from "@tetraboard/shogi";
import {
  createRoomContract,
  fourShogiReplayEventSchema,
  getRoomContract,
  roomSchema,
} from "@tetraboard/protocol";
import legacy from "../../../test-fixtures/matches/shogi-legacy.json";
import { waitingRoomFactories } from "../src/adapters/room/waitingRoomFactories";
import { type ShogiMatchRecord } from "../src/adapters/record/shogiMatchStore";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import { standardShogiRecord } from "./standardShogiFixtures";
import { resetDurableObjectStorage } from "./durableObjectCleanup";

const stubs: ReturnType<typeof env.GAME_ROOM.getByName>[] = [];
const ids: string[] = [];
function durableObject() {
  const stub = env.GAME_ROOM.getByName(`legacy-shogi-${crypto.randomUUID()}`);
  stubs.push(stub);
  return stub;
}
afterEach(async () => {
  for (const stub of stubs.splice(0)) await resetDurableObjectStorage(stub);
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
        expect(state.storage.kv.get("room-state-version")).toBe(2);
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
  record.game.drawProposals = [];
  ids.push(record.id);
  return { record, events: fixture.events };
}

for (const game of ["four-shogi", "shogi"] as const)
  for (const scenario of [
    { name: "引分提案のない保存待ち", manifest: false, current: false },
    { name: "引分提案のない保存待ちとmanifest", manifest: true, current: false },
    { name: "現行の保存待ちと引分提案のないmanifest", manifest: true, current: true },
  ]) {
    test(`${game}: ${scenario.name}を補完せずに拒否する`, async () => {
      const { record, events } = archiveFixture(game);
      const legacyRecord = structuredClone(record);
      delete (legacyRecord.game as Partial<typeof legacyRecord.game>).drawProposals;
      const original = JSON.stringify(legacyRecord);
      const pending = scenario.current ? record : legacyRecord;
      const pendingJson = JSON.stringify(pending);
      if (scenario.manifest)
        await env.APP_DB.prepare("INSERT INTO match_uploads VALUES(?,?,?,?)")
          .bind(record.id, original, events.length, Math.ceil(events.length / 100))
          .run();
      await expect(
        advanceShogiMatchSave(env.APP_DB, pending, { phase: "upload", cursor: 0 }, (cursor) =>
          events.slice(cursor, cursor + 100),
        ),
      ).rejects.toThrow();
      expect(JSON.stringify(pending)).toBe(pendingJson);
      expect(
        await env.APP_DB.prepare("SELECT record_json FROM match_uploads WHERE id=?")
          .bind(record.id)
          .first("record_json"),
      ).toBe(scenario.manifest ? original : null);
      expect(
        await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(record.id).first(),
      ).toBeNull();
    });
  }

test("現行manifestと結果が異なる再送を拒否し、元のmanifestを保持する", async () => {
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
