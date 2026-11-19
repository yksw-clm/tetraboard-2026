import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  fourShogiRoomSchema,
  roomSchema,
  tournamentDetailSchema,
  tournamentSettingsSchema,
} from "@tetraboard/protocol";
import {
  useTournamentQueueFixtures,
  request,
  requireMatched,
  connect,
  returnNotice,
  fixture,
} from "./tournamentQueueFixtures";

useTournamentQueueFixtures();

test("開始前の明示退室者を再待機させず、他の接続者に復帰を通知して待機へ戻す", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const { roomId } = requireMatched(await f.status(0));
  const clients = [];
  for (let i = 0; i < 3; i++) clients.push(await connect(roomId, f.operations[i]!.token));
  const actorNotice = returnNotice(clients[0]!),
    otherNotice = returnNotice(clients[1]!);
  expect(
    (
      await request(`/rooms/${roomId}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.operations[0]!.token}` },
      })
    ).status,
  ).toBe(204);
  expect(await actorNotice).toMatchObject({ reason: "left", tournamentId: f.id });
  expect(await otherNotice).toMatchObject({ reason: "unavailable", tournamentId: f.id });
  await runDurableObjectAlarm(f.stub);
  expect((await f.status(0)).status).toBe("idle");
  for (const i of [1, 2])
    expect(await f.status(i)).toMatchObject({
      status: "waiting",
      operationId: f.operations[i]!.operationId,
      controller: "self",
      controllerVersion: 1,
    });
  expect((await f.status(3)).status).toBe("idle");
});

test("4人の抽選で固定ルールの専用ルームへ直ちに移譲し、秘密の生トークンは保存しない", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const matched = requireMatched(await f.status(0));
  const response = await request(`/rooms/${matched.roomId}`);
  const room = fourShogiRoomSchema.parse(((await response.json()) as { room: unknown }).room);
  expect(room.tournamentId).toBe(f.id);
  expect(room.players).toHaveLength(4);
  expect(room.settings.timeControl).toEqual({ mainTimeMs: 0, byoyomiMs: 30000 });
  expect(room.settings.threePlayerAttackProhibited).toBe(true);
  expect(
    (
      await env.APP_DB.prepare("SELECT account_id FROM account_room_seats WHERE instance_id=?")
        .bind(matched.instanceId)
        .all()
    ).results,
  ).toHaveLength(4);
  expect(
    (
      await env.APP_DB.prepare(
        "SELECT account_id FROM tournament_wait_reservations WHERE tournament_key=?",
      )
        .bind(f.key)
        .all()
    ).results,
  ).toHaveLength(0);
  const saved = await runInDurableObject(f.stub, async (_instance, state) =>
    JSON.stringify([...state.storage.kv.list()]),
  );
  for (const credential of f.operations) expect(saved).not.toContain(credential.token);
  expect(JSON.stringify(matched)).not.toMatch(/token|accountId|admission/);
  expect((await f.queue(0)).status).toBe(200);
  expect(
    (await f.invoke(0, "queue", "POST", { ...f.operations[0], operationId: crypto.randomUUID() }))
      .status,
  ).toBe(409);
  await f.invoke(0, "queue", "DELETE", { operationId: f.operations[0]!.operationId });
});

test("旧画面の承諾・拒否は成立した予約を変更せず、明示取消だけが本人を外す", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const group = requireMatched(await f.status(0));
  expect(
    (
      await f.invoke(0, "confirmation", "POST", {
        operationId: f.operations[0]!.operationId,
        matchId: group.matchId,
        accept: false,
      })
    ).status,
  ).toBe(200);
  expect((await f.status(0)).status).toBe("matched");
  expect(
    (
      await f.invoke(1, "confirmation", "POST", {
        operationId: f.operations[1]!.operationId,
        matchId: group.matchId,
        accept: true,
      })
    ).status,
  ).toBe(200);
  expect((await f.status(1)).matchId).toBe(group.matchId);
  await f.invoke(0, "queue", "DELETE", { operationId: f.operations[0]!.operationId });
  expect((await f.status(0)).status).toBe("idle");
  for (let i = 1; i < 4; i++) expect((await f.status(i)).status).toBe("waiting");
  expect((await f.queue(0)).status).toBe(409);
  expect(
    (
      await f.invoke(1, "confirmation", "POST", {
        operationId: f.operations[1]!.operationId,
        matchId: group.matchId,
        accept: true,
      })
    ).status,
  ).toBe(409);
  const match = await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
    .bind(group.matchId)
    .first<{ phase: string }>();
  expect(match?.phase).toBe("aborted");
  for (let i = 1; i < 4; i++)
    await f.invoke(i, "queue", "DELETE", { operationId: f.operations[i]!.operationId });
});

test("取消の先着と世代違いを区別し、heartbeatは失効した待機を再生しない", async () => {
  const f = await fixture(1),
    op = f.operations[0]!;
  expect((await f.invoke(0, "queue", "DELETE", { operationId: op.operationId })).status).toBe(200);
  expect((await f.queue(0)).status).toBe(409);
  f.operations[0] = { ...op, operationId: crypto.randomUUID() };
  await f.enqueue(0);
  await evictDurableObject(f.stub);
  expect((await f.status(0)).operationId).toBe(f.operations[0]!.operationId);
  await f.invoke(0, "queue", "DELETE", { operationId: op.operationId });
  expect((await f.status(0)).status).toBe("waiting");
  await f.invoke(0, "queue", "PATCH", { operationId: f.operations[0]!.operationId });
  await runInDurableObject(f.stub, async (_instance, state) => {
    const current = state.storage.kv.get<{
      key: string;
      waiting: { expiresAtMs: number }[];
      groups: unknown[];
    }>("state")!;
    current.waiting[0]!.expiresAtMs = Date.now() - 1;
    state.storage.kv.put("state", current);
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(f.stub);
  expect((await f.status(0)).status).toBe("idle");
  expect(
    (await f.invoke(0, "queue", "PATCH", { operationId: f.operations[0]!.operationId })).status,
  ).toBe(409);
  expect((await f.queue(0)).status).toBe(409);
});

test("4席移譲の保存失敗は全件rollbackし、同じ予約を取り消して全席を解放できる", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.enqueue(i);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test transfer fault'); END",
  );
  expect((await f.queue(3)).status).toBe(503);
  expect(
    (
      await env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id IN (?,?,?,?)")
        .bind(...f.users.map((u) => u.id))
        .all()
    ).results,
  ).toHaveLength(0);
  await env.APP_DB.exec("DROP TRIGGER fail_tournament_transfer");
  expect(
    (await f.invoke(0, "queue", "DELETE", { operationId: f.operations[0]!.operationId })).status,
  ).toBe(200);
  expect((await f.status(0)).status).toBe("idle");
  for (let i = 1; i < 4; i++) {
    expect((await f.status(i)).status).toBe("waiting");
    await f.invoke(i, "queue", "DELETE", { operationId: f.operations[i]!.operationId });
  }
});

test("終了時刻以降の未開始予約を解放して不成立を確定し、開始済み台帳は結果待ちに残す", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const group = requireMatched(await f.status(0));
  await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 1, f.key)
    .run();
  const initial = tournamentDetailSchema.parse(
    await (await request(`/tournaments/${f.id}`)).json(),
  );
  expect(initial.tournament.status).toBe("settling");
  await f.stub.refresh(f.key);
  const detail = tournamentDetailSchema.parse(await (await request(`/tournaments/${f.id}`)).json());
  expect(detail.tournament.status).toBe("finished");
  expect(detail.tournament.completedCount).toBe(0);
  expect((await f.status(0)).status).toBe("idle");
  expect(
    (
      await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
        .bind(group.matchId)
        .first<{ phase: string }>()
    )?.phase,
  ).toBe("aborted");
  expect((await f.invoke(0, "entries", "POST", {})).status).toBe(409);
  const g = await fixture(1);
  await env.APP_DB.prepare(
    "INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,started_at_ms,updated_at_ms) VALUES(?,?,?,?,'saving',?,?)",
  )
    .bind(crypto.randomUUID(), g.key, "86748", crypto.randomUUID(), Date.now() - 10000, Date.now())
    .run();
  await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 1, g.key)
    .run();
  const pending = tournamentDetailSchema.parse(
    await (await request(`/tournaments/${g.id}`)).json(),
  );
  expect(pending.tournament.status).toBe("settling");
  expect(pending.tournament.pendingCount).toBe(1);
  expect(pending.tournament.finalizedAtMs).toBeNull();
});

test("通常ルーム参加と大会待機が同時に来ても、一方だけがアカウントを確保する", async () => {
  const f = await fixture(1);
  const [queue, room] = await Promise.all([
    f.queue(0),
    request("/rooms", {
      method: "POST",
      headers: f.users[0]!.headers,
      body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: false }),
    }),
  ]);
  expect([queue.status, room.status].filter((s) => s === 200 || s === 201)).toHaveLength(1);
  expect([queue.status, room.status]).toContain(409);
  const seats = (
    await env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
      .bind(f.users[0]!.id)
      .all()
  ).results.length;
  const waits = (
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(f.users[0]!.id)
      .all()
  ).results.length;
  expect(seats + waits).toBe(1);
  if (waits) await f.invoke(0, "queue", "DELETE", { operationId: f.operations[0]!.operationId });
  if (room.status === 201) {
    const created = (await room.json()) as { room: { id: string }; membership: { token: string } };
    expect(
      (
        await request(`/rooms/${created.room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${created.membership.token}` },
        })
      ).status,
    ).toBe(204);
  }
});

test("ルーム接続が成立しなかった場合、接続済み3人の同じ資格を次の組合せへ引き継ぐ", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const first = requireMatched(await f.status(0));
  for (let i = 0; i < 3; i++) await connect(first.roomId, f.operations[i]!.token);
  await runInDurableObject(f.stub, async (_instance, state) => {
    const current = state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!;
    current.groups[0]!.expiresAtMs = Date.now() - 1;
    state.storage.kv.put("state", current);
  });
  await runDurableObjectAlarm(f.stub);
  for (let i = 0; i < 3; i++) expect((await f.status(i)).status).toBe("waiting");
  expect((await f.status(3)).status).toBe("idle");
  f.operations[3] = {
    operationId: crypto.randomUUID(),
    token: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
    controllerId: crypto.randomUUID(),
  };
  await f.enqueue(3);
  const second = requireMatched(await f.status(0));
  expect(second.matchId).not.toBe(first.matchId);
  expect(second.roomId).not.toBe(first.roomId);
  for (let i = 0; i < 3; i++) await connect(second.roomId, f.operations[i]!.token);
  await f.invoke(3, "queue", "DELETE", { operationId: f.operations[3]!.operationId });
});

for (const game of ["four-reversi", "four-gomoku"] as const) {
  test(`${game}の大会待機から公開設定を持つ専用ルームを作成し、DO再起動後も同じ組へ復帰する`, async () => {
    const f = await fixture();
    const settings = tournamentSettingsSchema.parse({
      game,
      mode: "singles",
      timeControl: { mainTimeMs: 60000, byoyomiMs: 10000 },
    });
    await env.APP_DB.prepare(
      "UPDATE tournaments SET rule_version=2,game=?,settings_json=? WHERE key=?",
    )
      .bind(game, JSON.stringify(settings), f.key)
      .run();
    await f.enqueueAll();
    const matched = requireMatched(await f.status(0));
    const room = roomSchema.parse(await env.GAME_ROOM.getByName(matched.roomId).getRoom());
    expect(room.settings).toEqual(settings);
    expect(room).toHaveProperty("tournamentId", f.id);
    const indexed = await env.APP_DB.prepare(
      "SELECT match_sequence FROM room_index WHERE room_id=? AND instance_id=?",
    )
      .bind(matched.roomId, matched.instanceId)
      .first<{ match_sequence: number }>();
    expect(indexed?.match_sequence).toBe(1);
    await evictDurableObject(f.stub);
    const gameRoom = env.GAME_ROOM.getByName(matched.roomId);
    await evictDurableObject(gameRoom);
    await gameRoom.refreshLobbyIndex(matched.instanceId!, 0);
    expect(
      (
        await env.APP_DB.prepare(
          "SELECT match_sequence FROM room_index WHERE room_id=? AND instance_id=?",
        )
          .bind(matched.roomId, matched.instanceId)
          .first<{ match_sequence: number }>()
      )?.match_sequence,
    ).toBe(1);
    expect(await f.status(0)).toMatchObject({
      status: "matched",
      roomId: matched.roomId,
      matchId: matched.matchId,
      instanceId: matched.instanceId,
    });
  });
}
