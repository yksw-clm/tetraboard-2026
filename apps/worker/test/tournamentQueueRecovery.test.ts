import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { createRoomContract, shogiMatchmakingRules } from "@tetraboard/protocol";
import { insertDeletionStatement } from "../src/adapters/privacy/deletionRequest";
import { D1TournamentEntries } from "../src/adapters/tournament/entries";
import { DurableTournamentStorage } from "../src/adapters/tournament/storage";
import * as tournamentRoomPreparation from "../src/flows/tournamentRoom/prepare";
import type { State } from "@tetraboard/context-tournament";
import { accountFixture } from "./accountFixtures";
import {
  useTournamentQueueFixtures,
  request,
  roomCandidates,
  roomIds,
  clock,
  expectOk,
  requireMatched,
  connect,
  fixture,
  suspendDuringPreparation,
} from "./tournamentQueueFixtures";

useTournamentQueueFixtures();

test("旧版の確認待ちを休止後に復元し、全員未承諾でも同じ対局を自動準備する", async () => {
  const f = await fixture();
  const matchId = crypto.randomUUID(),
    instanceId = crypto.randomUUID();
  const roomId = roomIds.next();
  const expiresAtMs = Date.now() + 30000;
  const players = await Promise.all(
    f.users.map(async (user, index) => {
      const entry = (await env.APP_DB.prepare(
        "SELECT id FROM tournament_entries WHERE account_id=? AND tournament_key=?",
      )
        .bind(user.id, f.key)
        .first<{ id: string }>())!;
      const tokenHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(f.operations[index]!.token),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        accountId: user.id,
        operationId: f.operations[index]!.operationId,
        tokenHash,
        expiresAtMs,
        entryId: entry.id,
        confirmed: false,
        admission: {
          accountId: user.id,
          operationId: crypto.randomUUID(),
          roomId,
          instanceId,
          playerId: crypto.randomUUID(),
          name: "登録名",
          avatarKey: null,
        },
      };
    }),
  );
  await env.APP_DB.batch(
    players.map((player) =>
      env.APP_DB.prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)").bind(
        player.accountId,
        f.key,
        player.operationId,
        expiresAtMs,
      ),
    ),
  );
  await runInDurableObject(f.stub, async (_instance, state) => {
    state.storage.kv.put("state", {
      key: f.key,
      waiting: [],
      groups: [{ id: matchId, roomId, instanceId, expiresAtMs, phase: "confirming", players }],
    });
    await state.storage.setAlarm(expiresAtMs);
  });
  await evictDurableObject(f.stub);
  await runDurableObjectAlarm(f.stub);
  for (let i = 0; i < 4; i++)
    expect(await f.status(i)).toMatchObject({ status: "matched", matchId });
});

test("番号が既存ルームと衝突しても、待機継続で再抽選のAlarmを遅らせず別の番号で成立する", async () => {
  const now = Date.now();
  const user = await accountFixture();
  const response = await request("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: false }),
  });
  expect(response.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await response.json());
  try {
    const occupied = env.GAME_ROOM.getByName(room.id);
    await occupied.refreshLobbyIndex(room.instanceId, 0);
    const removed = await env.APP_DB.prepare("DELETE FROM room_index WHERE room_id=?")
      .bind(room.id)
      .run();
    expect(removed.meta.changes).toBe(1);
    roomIds.exclude(room.id);
    roomCandidates.push(room.id);
    const f = await fixture();

    await f.enqueueAll();
    const ledger = await env.APP_DB.prepare(
      "SELECT room_id, phase FROM tournament_matches WHERE tournament_key=?",
    )
      .bind(f.key)
      .all();
    expect(ledger.results).toEqual([{ room_id: room.id, phase: "aborted" }]);
    for (let i = 0; i < 4; i++)
      expect(await f.status(i)).toMatchObject({
        status: "waiting",
        operationId: f.operations[i]!.operationId,
      });

    const alarmAt = now + 5000;
    expect(await f.alarmTime()).toBe(alarmAt);
    for (let i = 0; i < 4; i++) {
      const heartbeatAt = now + (i + 1) * 1000;
      clock.mockReturnValue(heartbeatAt);
      await expectOk(
        await f.invoke(i, "queue", "PATCH", { operationId: f.operations[i]!.operationId }),
        `参加者${i + 1}の待機継続 PATCH`,
      );
      expect(await f.status(i)).toMatchObject({
        status: "waiting",
        expiresAtMs: heartbeatAt + 30_000,
      });
      expect(await f.alarmTime(), `参加者${i + 1}の待機継続後のAlarm`).toBe(alarmAt);
    }

    clock.mockReturnValue(alarmAt);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    const matched = requireMatched(await f.status(0));
    expect(matched.roomId).not.toBe(room.id);
    for (let i = 1; i < 4; i++)
      expect(await f.status(i)).toMatchObject({
        status: "matched",
        roomId: matched.roomId,
        matchId: matched.matchId,
        operationId: f.operations[i]!.operationId,
      });
    expect(await occupied.getRoom()).toMatchObject({ instanceId: room.instanceId });
  } finally {
    const leave = await request(`/rooms/${room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${membership.token}` },
    });
    expect(leave.status).toBe(204);
  }
});

async function prepareRollbackWithLaterGroup() {
  const f = await fixture(8);
  const now = Date.now();
  for (const i of [4, 5, 6, 7]) await f.enqueue(i);
  const laterMatch = requireMatched(await f.status(4));
  for (const i of [0, 1, 2]) await f.enqueue(i);
  await suspendDuringPreparation(f);
  const accountId = await runInDurableObject(f.stub, (_instance, state) => {
    const stored = state.storage.kv.get<State>("state")!;
    // 準備中の組の復帰に続けて、成立済みの組の入室期限を同じAlarmで処理します。
    stored.groups.reverse();
    state.storage.kv.put("state", stored);
    return stored.groups[0]!.players[0]!.accountId;
  });
  const index = f.users.findIndex((user) => user.id === accountId);
  const heartbeatAt = now + 25_000;
  clock.mockReturnValue(heartbeatAt);
  for (const i of [0, 1, 2, 3])
    await expectOk(
      await f.invoke(i, "queue", "PATCH", { operationId: f.operations[i]!.operationId }),
      `参加者${i + 1}の準備中の待機継続`,
    );

  clock.mockReturnValue(now + 30_000);
  return {
    f,
    accountId,
    index,
    laterMatchId: laterMatch.matchId,
    expiresAtMs: heartbeatAt + 30_000,
  };
}

async function expectRollbackWithLaterGroup({
  f,
  accountId,
  index,
  laterMatchId,
  expiresAtMs,
}: Awaited<ReturnType<typeof prepareRollbackWithLaterGroup>>) {
  await expect(runDurableObjectAlarm(f.stub)).resolves.toBe(true);
  expect((await f.stub.status(f.key, accountId)).status).toBe("idle");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(accountId)
      .first(),
  ).toBeNull();
  for (const i of [0, 1, 2, 3].filter((i) => i !== index))
    expect(await f.status(i)).toMatchObject({
      status: "waiting",
      operationId: f.operations[i]!.operationId,
      expiresAtMs,
    });
  expect((await f.status(4)).status).toBe("idle");
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(laterMatchId)
      .first(),
  ).toEqual({ phase: "aborted" });
}

test("準備中に通常ルームへ入った人だけを復帰から外し、同じAlarmで次の組も処理する", async () => {
  const prepared = await prepareRollbackWithLaterGroup();
  const { f, accountId, index } = prepared;
  const response = await request("/rooms", {
    method: "POST",
    headers: f.users[index]!.headers,
    body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: false }),
  });
  expect(response.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await response.json());
  try {
    await expectRollbackWithLaterGroup(prepared);
    expect(
      await env.APP_DB.prepare(
        "SELECT room_id,instance_id FROM account_room_seats WHERE account_id=?",
      )
        .bind(accountId)
        .first(),
    ).toEqual({ room_id: room.id, instance_id: room.instanceId });
  } finally {
    const leave = await request(`/rooms/${room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${membership.token}` },
    });
    expect(leave.status).toBe(204);
  }
});

test("準備中にレート戦の待機に入った人だけを復帰から外し、同じAlarmで次の組も処理する", async () => {
  const prepared = await prepareRollbackWithLaterGroup();
  const { accountId } = prepared;
  const queue = env.MATCHMAKING_COORDINATOR.getByName(shogiMatchmakingRules.key);
  const operationId = crypto.randomUUID();
  const controllerId = crypto.randomUUID();
  expect(await queue.join(accountId, operationId, controllerId)).toMatchObject({
    ok: true,
    state: { status: "waiting", operationId, version: 1 },
  });
  try {
    await expectRollbackWithLaterGroup(prepared);
    expect(await queue.status(accountId, controllerId, false)).toMatchObject({
      status: "waiting",
      operationId,
    });
  } finally {
    expect(
      await queue.control(accountId, { operationId, controllerId, version: 1 }, "cancel"),
    ).toMatchObject({ ok: true, state: { status: "idle" } });
  }
});

test("復帰の資格確認直後に退会した人だけを復帰から外し、同じAlarmで次の組も処理する", async () => {
  const prepared = await prepareRollbackWithLaterGroup();
  const { f, accountId } = prepared;
  const eligible = D1TournamentEntries.prototype.eligible;
  const deletion = vi
    .spyOn(D1TournamentEntries.prototype, "eligible")
    .mockImplementation(async function (this: D1TournamentEntries, id, key) {
      const profile = await eligible.call(this, id, key);
      if (profile && id === accountId && key === f.key)
        await insertDeletionStatement(
          env.APP_DB,
          { accountId, batchReceipt: crypto.randomUUID() },
          Date.now(),
        ).run();
      return profile;
    });
  try {
    await expectRollbackWithLaterGroup(prepared);
    expect(
      await env.APP_DB.prepare("SELECT id FROM deleted_accounts WHERE id=?")
        .bind(accountId)
        .first(),
    ).toEqual({ id: accountId });
  } finally {
    deletion.mockRestore();
  }
});

test("旧形式の取消途中の組から復旧した接続者に、復帰時刻から30秒の待機を与える", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const { roomId } = requireMatched(await f.status(0));
  for (const i of [0, 1, 2]) await connect(roomId, f.operations[i]!.token);
  const cancelledAtMs = await runInDurableObject(f.stub, (_instance, state) => {
    const stored = state.storage.kv.get<State>("state")!;
    const group = stored.groups[0]!;
    // 旧版が入室猶予の終了を検知し、接続者の期限を付け直してから保存した状態です。
    group.phase = "cancelling";
    const disconnectedAccount = f.users[3]!.id;
    group.remove = [disconnectedAccount];
    delete group.rollbackAfterPublication;
    for (const player of group.players) {
      delete player.waitingExpiresAtMs;
      if (player.accountId !== disconnectedAccount) player.expiresAtMs = group.expiresAtMs + 30_000;
    }
    state.storage.kv.put("state", stored);
    return group.expiresAtMs;
  });

  const resumedAtMs = cancelledAtMs + 5000;
  clock.mockReturnValue(resumedAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  const expiresAtMs = resumedAtMs + 30_000;
  for (const i of [0, 1, 2])
    expect(await f.status(i)).toMatchObject({
      status: "waiting",
      operationId: f.operations[i]!.operationId,
      expiresAtMs,
    });
  expect((await f.status(3)).status).toBe("idle");
  clock.mockReturnValue(expiresAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  for (const i of [0, 1, 2]) expect((await f.status(i)).status).toBe("idle");
});

test("ルーム準備後に成立の保存が失敗しても、元の待機期限を越えて同じ組を配信する", async () => {
  const f = await fixture();
  const now = Date.now();
  await f.enqueue(0);
  clock.mockReturnValue(now + 25_000);
  for (const i of [1, 2]) await f.enqueue(i);
  const save = DurableTournamentStorage.prototype.save;
  const fault = vi.spyOn(DurableTournamentStorage.prototype, "save").mockImplementation(function (
    this: DurableTournamentStorage,
    state: State,
  ) {
    if (state.groups.some((group) => group.phase === "matched"))
      throw new Error("test matched save fault");
    save.call(this, state);
  });
  try {
    expect((await f.queue(3)).status).toBe(503);
  } finally {
    fault.mockRestore();
  }
  const reservation = await env.APP_DB.prepare(
    "SELECT id, room_id, instance_id FROM tournament_matches WHERE tournament_key=? AND phase='reserved'",
  )
    .bind(f.key)
    .first<{ id: string; room_id: string; instance_id: string }>();
  expect(reservation).not.toBeNull();
  const { id: matchId, room_id: roomId, instance_id: instanceId } = reservation!;
  const room = env.GAME_ROOM.getByName(roomId);
  expect(await room.getTournamentReservationState(matchId)).toMatchObject({ status: "waiting" });
  expect((await f.status(0)).status).toBe("waiting");

  clock.mockReturnValue(now + 30_001);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  for (let i = 0; i < 4; i++)
    expect(await f.status(i)).toMatchObject({ status: "matched", matchId, roomId, instanceId });
  expect(await room.getRoom()).toMatchObject({ instanceId });
});

test("ルーム準備のRPC応答を失っても、同じ組の予約を照合して成立を配信する", async () => {
  const f = await fixture();
  for (const i of [0, 1, 2]) await f.enqueue(i);
  const prepare = tournamentRoomPreparation.prepareTournamentRoom;
  const fault = vi
    .spyOn(tournamentRoomPreparation, "prepareTournamentRoom")
    .mockImplementationOnce(async (...args) => {
      expect(await prepare(...args)).toEqual({ status: "prepared" });
      throw new Error("test lost prepare response");
    });
  try {
    await f.enqueue(3);
  } finally {
    fault.mockRestore();
  }
  const matched = requireMatched(await f.status(0));
  for (const i of [1, 2, 3])
    expect(await f.status(i)).toMatchObject({
      status: "matched",
      matchId: matched.matchId,
      roomId: matched.roomId,
      instanceId: matched.instanceId,
    });
});

test("ルーム準備後にD1で失敗しても、元の待機期限を越えて同じルームの成立を復旧する", async () => {
  const f = await fixture();
  const now = Date.now();
  await f.enqueue(0);
  clock.mockReturnValue(now + 25_000);
  for (const i of [1, 2]) await f.enqueue(i);
  const originalWaitingExpiry = now + 30_000;
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_wait_release BEFORE DELETE ON tournament_wait_reservations WHEN OLD.match_operation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test wait release fault'); END",
  );
  try {
    expect((await f.queue(3)).status).toBe(503);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_tournament_wait_release");
  }

  expect((await f.status(0)).status).toBe("matched");
  const reservation = await env.APP_DB.prepare(
    "SELECT id, room_id, instance_id FROM tournament_matches WHERE tournament_key=? AND phase='reserved'",
  )
    .bind(f.key)
    .first<{ id: string; room_id: string; instance_id: string }>();
  expect(reservation).not.toBeNull();
  const { id: matchId, room_id: roomId, instance_id: instanceId } = reservation!;
  const room = env.GAME_ROOM.getByName(roomId);
  expect(await room.getTournamentReservationState(matchId)).toMatchObject({ status: "waiting" });
  expect(await f.alarmTime()).toBe(originalWaitingExpiry);

  clock.mockReturnValue(originalWaitingExpiry + 1);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  for (let i = 0; i < 4; i++)
    expect(await f.status(i)).toMatchObject({ status: "matched", matchId, roomId, instanceId });
  expect(await room.getRoom()).toMatchObject({ instanceId });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE tournament_key=?")
      .bind(f.key)
      .first(),
  ).toBeNull();
});

test("大会の採番失敗は503となり、Alarmによる再準備で番号を確定して再取得で維持する", async () => {
  const f = await fixture();
  const now = Date.now();
  for (let i = 0; i < 3; i++) await f.enqueue(i);
  const alarmAt = now + 30_000;
  expect(await f.alarmTime()).toBe(alarmAt);
  clock.mockReturnValue(alarmAt - 4000);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_match_sequence BEFORE INSERT ON room_match_sequences BEGIN SELECT RAISE(ABORT,'test sequence fault'); END",
  );
  try {
    expect((await f.queue(3)).status).toBe(503);
    expect(await f.alarmTime()).toBe(alarmAt);
    expect(
      (
        await env.APP_DB.prepare("SELECT 1 FROM room_match_sequences WHERE scope=?")
          .bind(`tournament:${f.key}`)
          .all()
      ).results,
    ).toHaveLength(0);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_match_sequence");
  }
  clock.mockReturnValue(alarmAt);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  const matched = requireMatched(await f.status(0));
  const room = env.GAME_ROOM.getByName(matched.roomId);
  const read = async () => {
    let cursor: string | null = null;
    do {
      const path =
        "/lobby/rooms?view=cards&includeMatchKind=1&includeMatchSequence=1" +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const response = await request(path);
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        rooms: { id: string; matchSequence?: number }[];
        nextCursor: string | null;
      };
      const entry = result.rooms.find((entry) => entry.id === matched.roomId);
      if (entry) return entry.matchSequence;
      cursor = result.nextCursor;
    } while (cursor !== null);
    throw new Error("Prepared room missing from lobby");
  };
  expect(await read()).toBe(1);

  expect((await f.status(0)).matchId).toBe(matched.matchId);
  expect(await read()).toBe(1);
  expect(await room.getPublicMetadata()).not.toHaveProperty("matchSequence");
  expect(await room.getPublicMetadata(true)).not.toHaveProperty("matchSequence");
});
