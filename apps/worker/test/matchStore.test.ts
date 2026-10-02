import { accountFixture } from "./accountFixtures";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { applyAction, createInitialState, getLegalMoves } from "@tetraboard/four-reversi";
import { roomSchema } from "@tetraboard/protocol";
import {
  matchStartKey,
  pendingMatchPrefix,
  writeMatch,
  type MatchStart,
  type MatchRecord,
  type PendingMatch,
} from "../src/rooms/matchStore";
import {
  matchClients,
  matchSetup,
  matchStart,
  matchLeave,
  matchRoom,
  storedMatch,
} from "./matchFixtures";

afterEach(() => {
  for (const c of matchClients.splice(0)) c.close();
});
async function completed(mode: "singles" | "doubles" = "singles") {
  const setup = await matchSetup(mode);
  const room = await matchStart(setup);
  const start = await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
    state.storage.kv.get<MatchStart>(matchStartKey)!,
  );
  const departures = mode === "singles" ? setup.memberships.slice(0, 3) : [setup.memberships[0]];
  for (const membership of departures) await matchLeave(setup.id, membership);
  await vi.waitFor(async () => expect(await storedMatch(start.id)).not.toBeNull());
  return {
    setup,
    room,
    start,
    record: JSON.parse((await storedMatch(start.id))!.record_json) as MatchRecord,
  };
}
for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 開始時の本人情報・退室結果・最終盤面・棋譜を保存する`, async () => {
    const { setup, room, start, record } = await completed(mode);
    expect(record).toMatchObject({ ...start, game: { status: "finished", mode } });
    expect(record.endedAtMs).toBeGreaterThanOrEqual(record.startedAtMs);
    expect(record.participants).toEqual(
      room.players.map((p, seat) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        seat,
        kind: "human",
        accountId: seat === 0 ? setup.user.id : null,
      })),
    );
    expect(record.eliminations.map((e) => e.reason)).toEqual(
      mode === "singles" ? ["left", "left", "left"] : ["left"],
    );
    expect(record.replay.id).toBe(start.id);
    expect(record.replay.steps.at(-1)?.game).toEqual(record.game);
    expect(
      await env.APP_DB.prepare("SELECT match_id FROM account_match_history WHERE account_id = ?")
        .bind(setup.user.id)
        .all(),
    ).toMatchObject({ results: [{ match_id: start.id }] });
    expect(JSON.stringify(await matchRoom(setup.id))).not.toContain(setup.user.id);
  });
}

test("通常終局の棋譜を初期盤面から再現でき、保存済み結果と一致する", async () => {
  const setup = await matchSetup();
  let room = await matchStart(setup);
  for (let move = 0; move < 64; move++) {
    const player = room.players.findIndex((p) => p.color === room.game.turn);
    const position = getLegalMoves(room.game)[0];
    setup.clients[player].send({
      type: "room.game.action",
      action: { type: "placeStone", position },
    });
    const number = room.game.moveNumber;
    const next = await setup.clients[0].snapshot(
      (r) => r.status === "waiting" || r.game.moveNumber > number,
    );
    if (next.status === "waiting") {
      const id = next.lastRound!.replay!.id;
      await vi.waitFor(async () => expect(await storedMatch(id)).not.toBeNull());
      const record = JSON.parse((await storedMatch(id))!.record_json) as MatchRecord;
      let game = createInitialState("singles");
      for (const step of record.replay.steps) {
        if (step.action.type !== "place") throw new Error("Unexpected action");
        const applied = applyAction(game, { type: "placeStone", position: step.action.position });
        if (!applied.ok) throw new Error("Illegal replay move");
        expect(applied.passedColors).toEqual(step.passedColors);
        expect(applied.state).toEqual(step.game);
        game = applied.state;
      }
      expect(record.game).toEqual(game);
      expect(record.replay.steps.some((step) => step.passedColors.length > 0)).toBe(true);
      return;
    }
    room = next;
  }
  throw new Error("Match never finished");
});

test("D1本体と全アカウント索引を一括保存し、再送では内容も件数も変えない", async () => {
  const { record } = await completed();
  const other = await accountFixture();
  const retry = {
    ...record,
    endedAtMs: record.endedAtMs + 1000,
    participants: record.participants.map((p) =>
      p.kind === "human" && p.accountId ? { ...p, accountId: other.id } : p,
    ),
  };
  await writeMatch(env.APP_DB, retry);
  expect(JSON.parse((await storedMatch(record.id))!.record_json)).toEqual(record);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(record.id)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE account_id = ?")
      .bind(other.id)
      .first(),
  ).toEqual({ n: 0 });
  const broken = {
    ...record,
    id: crypto.randomUUID(),
    participants: record.participants.map((p, i) =>
      i === 1 && p.kind === "human" ? { ...p, accountId: other.id } : p,
    ),
  };
  await env.APP_DB.prepare(`CREATE TRIGGER reject_history BEFORE INSERT ON account_match_history
    WHEN NEW.account_id = '${other.id}' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`).run();
  try {
    await expect(writeMatch(env.APP_DB, broken)).rejects.toThrow();
    expect(await storedMatch(broken.id)).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
        .bind(broken.id)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await env.APP_DB.exec("DROP TRIGGER reject_history");
  }
  await writeMatch(env.APP_DB, broken);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(broken.id)
      .first(),
  ).toEqual({ n: 2 });
});

test("保存失敗中の再戦・退室・閉鎖・部屋番号再利用後も複数局をAlarmで復旧する", async () => {
  const setup = await matchSetup();
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO matches_unavailable");
  const ids: string[] = [];
  const stub = env.GAME_ROOM.getByName(setup.id);
  try {
    for (let round = 0; round < 2; round++) {
      const room = await matchStart(setup);
      const start = await runInDurableObject(stub, (_, state) =>
        state.storage.kv.get<MatchStart>(matchStartKey)!,
      );
      ids.push(start.id);
      // Resign the current player three times, keeping all seats for the rematch.
      let current = room;
      for (let n = 0; n < 3; n++) {
        const index = current.players.findIndex((p) => p.color === current.game.turn);
        setup.clients[index].send({ type: "room.game.resign" });
        const next = await setup.clients[0].snapshot(
          (r) => r.status === "waiting" || r.game.eliminatedColors.length > n,
        );
        if (next.status === "playing") current = next;
      }
    }
    await vi.waitFor(async () => {
      const jobs = await runInDurableObject(stub, (_, state) => [
        ...new Map(state.storage.kv.list<PendingMatch>({ prefix: pendingMatchPrefix })).values(),
      ]);
      expect(jobs).toHaveLength(2);
      expect(jobs.some((job) => job.retryAtMs > Date.now())).toBe(true);
    });
    const waiting = await matchRoom(setup.id);
    for (const m of setup.memberships) await matchLeave(setup.id, m);
    const replacement = roomSchema.parse({
      ...waiting,
      instanceId: crypto.randomUUID(),
      lastRound: null,
      players: [{ ...waiting.players[0], id: crypto.randomUUID() }],
      lastActivityAtMs: Date.now(),
    });
    expect(await stub.createRoom(replacement, "a".repeat(64))).not.toBeNull();
  } finally {
    await env.APP_DB.exec("ALTER TABLE matches_unavailable RENAME TO matches");
  }
  await runInDurableObject(stub, async (_, state) => {
    for (const [key, job] of state.storage.kv.list<PendingMatch>({ prefix: pendingMatchPrefix }))
      state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  await vi.waitFor(async () => {
    for (const id of ids) expect(await storedMatch(id)).not.toBeNull();
  });
  // Simulate a successful D1 write whose acknowledgement was interrupted.
  const record = JSON.parse((await storedMatch(ids[0]))!.record_json) as MatchRecord;
  await runInDurableObject(stub, async (_, state) => {
    state.storage.kv.put(pendingMatchPrefix + record.id, { record, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(stub);
  await vi.waitFor(async () =>
    expect(
      await runInDurableObject(
        stub,
        (_, state) => new Map(state.storage.kv.list({ prefix: pendingMatchPrefix })).size,
      ),
    ).toBe(0),
  );
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE account_id = ?")
      .bind(setup.user.id)
      .first(),
  ).toEqual({ n: 2 });
});

test("導入前に開始した対局は開始情報を推測して保存しない", async () => {
  const setup = await matchSetup("doubles");
  await matchStart(setup);
  await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
    state.storage.kv.delete(matchStartKey),
  );
  await matchLeave(setup.id, setup.memberships[0]);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE account_id = ?")
      .bind(setup.user.id)
      .first(),
  ).toEqual({ n: 0 });
});

for (const reason of ["resigned", "timeout", "disconnected"] as const) {
  test(`ダブルスの${reason}による終局を保存する`, async () => {
    const setup = await matchSetup("doubles");
    const room = await matchStart(setup);
    const index = room.players.findIndex((p) => p.color === room.game.turn);
    const stub = env.GAME_ROOM.getByName(setup.id);
    const start = await runInDurableObject(stub, (_, state) =>
      state.storage.kv.get<MatchStart>(matchStartKey)!,
    );
    if (reason === "resigned") {
      setup.clients[index].send({ type: "room.game.resign" });
      await setup.clients[0].snapshot((r) => r.status === "waiting");
    } else {
      await runInDurableObject(stub, async (_, state) => {
        const current = roomSchema.parse(state.storage.kv.get("room"));
        if (current.status !== "playing") throw new Error("Not playing");
        const deadline = Date.now() - 1;
        state.storage.kv.put(
          "room",
          roomSchema.parse(
            reason === "timeout"
              ? { ...current, clock: { ...current.clock, turnExpiresAt: deadline } }
              : {
                  ...current,
                  players: current.players.map((p, i) =>
                    i === index ? { ...p, reconnectDeadline: deadline } : p,
                  ),
                },
          ),
        );
        await state.storage.setAlarm(Date.now() + 60000);
      });
      await runDurableObjectAlarm(stub);
    }
    await vi.waitFor(async () => expect(await storedMatch(start.id)).not.toBeNull());
    const record = JSON.parse((await storedMatch(start.id))!.record_json) as MatchRecord;
    expect(record.eliminations).toEqual([{ color: room.players[index].color, reason }]);
    expect(record.replay.steps.at(-1)?.action).toEqual({
      type: "eliminate",
      color: room.players[index].color,
      reason,
    });
  });
}

test("ゲストのみの対局も保存し、アカウントへ紐付けない", async () => {
  const setup = await matchSetup("doubles", false, true);
  await matchStart(setup);
  const start = await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
    state.storage.kv.get<MatchStart>(matchStartKey)!,
  );
  await matchLeave(setup.id, setup.memberships[0]);
  await vi.waitFor(async () => expect(await storedMatch(start.id)).not.toBeNull());
  const record = JSON.parse((await storedMatch(start.id))!.record_json) as MatchRecord;
  expect(record.participants.every((p) => p.kind === "human" && p.accountId === null)).toBe(true);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(start.id)
      .first(),
  ).toEqual({ n: 0 });
});

test("最後の人間が退室した後もCPUが終局し、閉鎖した部屋の記録を保存する", async () => {
  const setup = await matchSetup("singles", true);
  await matchStart(setup);
  const stub = env.GAME_ROOM.getByName(setup.id);
  const start = await runInDurableObject(stub, (_, state) =>
    state.storage.kv.get<MatchStart>(matchStartKey)!,
  );
  await matchLeave(setup.id, setup.memberships[0]);
  for (let move = 0; move < 65; move++) {
    const room = await stub.getRoom();
    if (!room) break;
    if (room.status !== "playing") throw new Error("CPU should finish before closure");
    await runInDurableObject(stub, async (_, state) => {
      const current = roomSchema.parse(state.storage.kv.get("room"));
      if (current.status !== "playing") return;
      state.storage.kv.put("room", {
        ...current,
        clock: { ...current.clock, turnStartedAt: Date.now() - 501 },
      });
      await state.storage.setAlarm(Date.now() + 60000);
    });
    await runDurableObjectAlarm(stub);
  }
  expect(await stub.getRoom()).toBeNull();
  await vi.waitFor(async () => expect(await storedMatch(start.id)).not.toBeNull());
  const record = JSON.parse((await storedMatch(start.id))!.record_json) as MatchRecord;
  expect(record.participants.filter((p) => p.kind === "cpu")).toHaveLength(3);
  expect(record.game.status).toBe("finished");
  expect(record.replay.steps.at(-1)?.game).toEqual(record.game);
});
