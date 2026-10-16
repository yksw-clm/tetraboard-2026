import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  tournamentParticipationSchema,
  fourShogiRoomSchema,
  tournamentDetailSchema,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
type Account = Awaited<ReturnType<typeof accountFixture>>;
const cleanup: {
  key: string;
  users: Account[];
  stub: DurableObjectStub<import("../src/tournaments/coordinator").TournamentCoordinator>;
}[] = [];
const sockets: WebSocket[] = [];
async function connect(roomId: string, token: string) {
  const response = await request(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const authenticated = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string };
      if (message.type === "room.authenticated") resolve();
      if (message.type === "room.error") reject(new Error("Room authentication failed"));
    });
  });
  socket.accept();
  sockets.push(socket);
  socket.send(JSON.stringify({ type: "room.auth", token }));
  await authenticated;
}
async function fixture(count = 4) {
  const key = crypto.randomUUID(),
    now = Date.now();
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'待機大会',?,?,1,?,?)`)
    .bind(key, now - 60000, now + 3600000, now, now)
    .run();
  const { public_id: id } = (await env.APP_DB.prepare(
    "SELECT public_id FROM tournaments WHERE key=?",
  )
    .bind(key)
    .first<{ public_id: number }>())!;
  const users: Account[] = [],
    operations: { operationId: string; token: string }[] = [];
  for (let i = 0; i < count; i++) {
    const u = await accountFixture();
    users.push(u);
    expect(
      (
        await request(`/tournaments/${id}/entries`, {
          method: "POST",
          headers: u.headers,
          body: "{}",
        })
      ).status,
    ).toBe(200);
    operations.push({
      operationId: crypto.randomUUID(),
      token: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
    });
  }
  const invoke = (index: number, path: string, method: string, body: unknown) =>
    request(`/tournaments/${id}/${path}`, {
      method,
      headers: users[index]!.headers,
      body: JSON.stringify(body),
    });
  const status = async (index: number) =>
    tournamentParticipationSchema.parse(
      await (
        await request(`/tournaments/${id}/participation`, { headers: users[index]!.headers })
      ).json(),
    );
  const queue = async (index: number) => invoke(index, "queue", "POST", operations[index]);
  const prepared = {
    key,
    id,
    users,
    operations,
    invoke,
    status,
    queue,
    stub: env.TOURNAMENT_COORDINATOR.getByName(key),
  };
  cleanup.push(prepared);
  return prepared;
}
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await env.APP_DB.exec("DROP TRIGGER IF EXISTS fail_tournament_transfer");
  for (const f of cleanup.splice(0)) {
    for (const u of f.users) await f.stub.cancelForAccount(u.id);
    await env.APP_DB.prepare(
      "UPDATE tournament_matches SET phase='aborted' WHERE tournament_key=? AND phase!='saved'",
    )
      .bind(f.key)
      .run();
    await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
      .bind(Date.now() - 1, f.key)
      .run();
    await f.stub.refresh(f.key);
    await runInDurableObject(f.stub, async (_instance, state) => state.storage.deleteAlarm());
  }
});

test("4人の抽選で固定ルールの専用ルームへ直ちに移譲し、秘密の生トークンは保存しない", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) expect((await f.queue(i)).status).toBe(200);
  const matched = await f.status(0);
  expect(matched.status).toBe("matched");
  expect(matched.roomId).toMatch(/^\d{5}$/);
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
  for (let i = 0; i < 4; i++) await f.queue(i);
  const group = await f.status(0);
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
  await f.queue(0);
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
  for (let i = 0; i < 3; i++) await f.queue(i);
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
  for (let i = 0; i < 4; i++) await f.queue(i);
  const group = await f.status(0);
  await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 1, f.key)
    .run();
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

test("旧版の確認待ちを休止後に復元し、全員未承諾でも同じ対局を自動準備する", async () => {
  const f = await fixture();
  const matchId = crypto.randomUUID(),
    instanceId = crypto.randomUUID();
  const roomId = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0");
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
  for (let i = 0; i < 4; i++)
    expect(await f.status(i)).toMatchObject({ status: "matched", matchId });
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
  for (let i = 0; i < 4; i++) await f.queue(i);
  const group = await f.status(0);
  const first = await f.status(0);
  for (let i = 0; i < 3; i++) await connect(first.roomId!, f.operations[i]!.token);
  await runInDurableObject(f.stub, async (_instance, state) => {
    const current = state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!;
    current.groups[0]!.expiresAtMs = Date.now() - 1;
    state.storage.kv.put("state", current);
  });
  for (let i = 0; i < 3; i++) expect((await f.status(i)).status).toBe("waiting");
  expect((await f.status(3)).status).toBe("idle");
  f.operations[3] = {
    operationId: crypto.randomUUID(),
    token: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
  };
  await f.queue(3);
  const secondGroup = await f.status(0);
  expect(secondGroup.matchId).not.toBe(group.matchId);
  const second = await f.status(0);
  expect(second.status).toBe("matched");
  expect(second.roomId).not.toBe(first.roomId);
  for (let i = 0; i < 3; i++) await connect(second.roomId!, f.operations[i]!.token);
  await f.invoke(3, "queue", "DELETE", { operationId: f.operations[3]!.operationId });
});
