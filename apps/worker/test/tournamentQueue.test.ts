import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  listDurableObjectIds,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import {
  createRoomContract,
  fourShogiRoomSchema,
  roomCodeSchema,
  roomSchema,
  shogiMatchmakingRules,
  tournamentControllerResponseSchema,
  tournamentDetailSchema,
  tournamentParticipationSchema,
  tournamentSettingsSchema,
  type TournamentParticipation,
} from "@tetraboard/protocol";
import { insertDeletionStatement } from "../src/adapters/privacy/deletionRequest";
import { D1TournamentEntries } from "../src/adapters/tournament/entries";
import * as tournamentRuntime from "../src/adapters/tournament/runtime";
import * as tournamentStore from "../src/adapters/tournament/store";
import { DurableTournamentStorage } from "../src/adapters/tournament/storage";
import * as tournamentRoomPreparation from "../src/flows/tournamentRoom/prepare";
import type { State } from "@tetraboard/context-tournament";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { fixTestTime } from "./fixedTimeFixture";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
type Account = Awaited<ReturnType<typeof accountFixture>>;
const cleanup: {
  key: string;
  users: Account[];
  stub: DurableObjectStub<
    import("../src/durableObjects/tournamentCoordinator/coordinator").TournamentCoordinator
  >;
}[] = [];
const sockets: WebSocket[] = [];
const roomCandidates: string[] = [];
let nextUnusedRoomId: () => string;
let clock: ReturnType<typeof fixTestTime>;

beforeEach(async () => {
  // 実時間で動くAlarmが手動実行より先に発火しないよう、基準を1時間先に置きます。
  clock = fixTestTime(Date.now() + 60 * 60 * 1000);
  roomCandidates.length = 0;
  // D1の索引を掃除した後も残るルームを、テストの採番から除外します。
  const existingRooms = new Set((await listDurableObjectIds(env.GAME_ROOM)).map(String));
  let nextRoomNumber = 0;
  nextUnusedRoomId = () => {
    while (nextRoomNumber < 100_000) {
      const roomId = String(nextRoomNumber++).padStart(5, "0");
      if (!existingRooms.has(env.GAME_ROOM.idFromName(roomId).toString())) return roomId;
    }
    throw new Error("テスト用の空きルーム番号がありません。");
  };
  const createRuntime = tournamentRuntime.createTournamentRuntime;
  const runtime = vi
    .spyOn(tournamentRuntime, "createTournamentRuntime")
    .mockImplementation((...args) => ({
      ...createRuntime(...args),
      randomRoomId: () => {
        const roomId = roomCandidates.shift();
        if (roomId === undefined) return nextUnusedRoomId();
        existingRooms.add(env.GAME_ROOM.idFromName(roomId).toString());
        return roomId;
      },
    }));
  onTestFinished(() => runtime.mockRestore());
});

async function expectOk(response: Response, label: string) {
  const detail = response.status === 200 ? label : `${label} の応答本文 ${await response.text()}`;
  expect(response.status, detail).toBe(200);
}

function requireMatched(participation: TournamentParticipation) {
  expect(participation, "対局成立後の参加状態").toMatchObject({ status: "matched" });
  return { ...participation, roomId: roomCodeSchema.parse(participation.roomId) };
}

async function connect(roomId: string, token: string) {
  const response = await request(`/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status, `/rooms/${roomId}/ws の応答`).toBe(101);
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
  return socket;
}

function returnNotice(socket: WebSocket) {
  return new Promise<{ type: string; reason: string; tournamentId: number }>((resolve) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        reason: string;
        tournamentId: number;
      };
      if (message.type === "room.tournament.return") resolve(message);
    });
  });
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
    operations: { operationId: string; token: string; controllerId: string }[] = [];
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
      controllerId: crypto.randomUUID(),
    });
  }
  const invoke = (index: number, path: string, method: string, body: unknown) =>
    request(`/tournaments/${id}/${path}`, {
      method,
      headers: users[index]!.headers,
      body: JSON.stringify(
        path === "queue" && ["PATCH", "DELETE"].includes(method)
          ? {
              controllerId: operations[index]!.controllerId,
              controllerVersion: 1,
              ...(body as object),
            }
          : body,
      ),
    });
  const status = async (index: number) => {
    const response = await request(`/tournaments/${id}/participation`, {
      headers: {
        ...users[index]!.headers,
        "X-Tournament-Controller": operations[index]!.controllerId,
      },
    });
    await expectOk(response, `参加者${index + 1}の参加状態 GET`);
    return tournamentParticipationSchema.parse(await response.json());
  };
  const queue = async (index: number) => invoke(index, "queue", "POST", operations[index]);
  const enqueue = async (index: number) => {
    await expectOk(await queue(index), `参加者${index + 1}の待機 POST`);
  };
  const enqueueAll = async () => {
    for (let i = 0; i < count; i++) await enqueue(i);
  };
  const matchedController = async (index: number) => {
    const { operationId, controllerId } = operations[index]!;
    const response = await invoke(index, "controller", "POST", {
      operationId,
      controllerId,
      takeover: false,
      expectedControllerVersion: 1,
    });
    await expectOk(response, `参加者${index + 1}の操作元 POST`);
    const { participation, token } = tournamentControllerResponseSchema.parse(
      await response.json(),
    );
    return { participation: requireMatched(participation), token };
  };
  const stub = env.TOURNAMENT_COORDINATOR.getByName(key);
  const prepared = {
    key,
    id,
    users,
    operations,
    invoke,
    status,
    queue,
    enqueue,
    enqueueAll,
    matchedController,
    stub,
    alarmTime: () => runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
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

test("本人の参加状態に操作元と引継ぎ世代を返し、未待機では所有者を持たない", async () => {
  const f = await fixture(1);
  expect(await f.status(0)).toMatchObject({
    status: "idle",
    controller: "none",
    controllerVersion: 0,
  });
});

test("待機の操作元をCASで引き継ぎ、旧タブの継続・取消・入室前確認を世代で拒否する", async () => {
  const f = await fixture(1),
    op = f.operations[0]!;
  expect((await f.queue(0)).status).toBe(200);
  const before = await f.status(0);
  expect(before).toMatchObject({ controller: "self", controllerVersion: 1, status: "waiting" });
  const nextId = crypto.randomUUID();
  const claim = {
    operationId: op.operationId,
    controllerId: nextId,
    takeover: true,
    expectedControllerVersion: 1,
  };
  const response = await f.invoke(0, "controller", "POST", claim);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const recovered = tournamentControllerResponseSchema.parse(await response.json());
  expect(recovered.participation).toMatchObject({
    status: "waiting",
    operationId: op.operationId,
    controller: "self",
    controllerVersion: 2,
    expiresAtMs: before.expiresAtMs,
  });
  expect(recovered.token).toMatch(/^[0-9a-f]{64}$/);
  expect(recovered.token).not.toBe(op.token);
  expect(await (await f.invoke(0, "controller", "POST", claim)).json()).toEqual(recovered);
  for (const method of ["PATCH", "DELETE"])
    expect((await f.invoke(0, "queue", method, { operationId: op.operationId })).status).toBe(409);
  expect(
    (
      await f.invoke(0, "controller", "POST", {
        ...claim,
        controllerId: op.controllerId,
        takeover: false,
      })
    ).status,
  ).toBe(409);
  expect((await f.status(0)).controller).toBe("other");
  expect(
    (
      await f.invoke(0, "queue", "PATCH", {
        operationId: op.operationId,
        controllerId: nextId,
        controllerVersion: 2,
      })
    ).status,
  ).toBe(200);
  expect(
    await runInDurableObject(f.stub, (_instance, state) =>
      state.storage.kv.get(`cancel:${op.operationId}`),
    ),
  ).toBeUndefined();
  const stored = await runInDurableObject(f.stub, (_instance, state) =>
    JSON.stringify([...state.storage.kv.list()]),
  );
  expect(stored).not.toContain(recovered.token);
  expect(JSON.stringify(await f.status(0))).not.toContain(nextId);
});

test("同じ世代への同時引継ぎは1件だけ成立し、同じIDでも旧世代操作を拒否する", async () => {
  const f = await fixture(1),
    op = f.operations[0]!;
  await f.enqueue(0);
  const claims = [crypto.randomUUID(), crypto.randomUUID()].map((controllerId) => ({
    operationId: op.operationId,
    controllerId,
    takeover: true,
    expectedControllerVersion: 1,
  }));
  const responses = await Promise.all(
    claims.map((claim) => f.invoke(0, "controller", "POST", claim)),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const current = tournamentControllerResponseSchema.parse(
    await responses.find((response) => response.status === 200)!.json(),
  );
  const back = await f.invoke(0, "controller", "POST", {
    operationId: op.operationId,
    controllerId: op.controllerId,
    takeover: true,
    expectedControllerVersion: current.participation.controllerVersion,
  });
  expect(back.status).toBe(200);
  const restored = tournamentControllerResponseSchema.parse(await back.json());
  expect(restored.participation.controllerVersion).toBe(3);
  expect(
    (
      await f.invoke(0, "controller", "POST", {
        operationId: op.operationId,
        controllerId: op.controllerId,
        takeover: true,
        expectedControllerVersion: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.invoke(0, "queue", "DELETE", {
        operationId: op.operationId,
        controllerId: op.controllerId,
        controllerVersion: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.invoke(0, "controller", "POST", {
        operationId: op.operationId,
        controllerId: op.controllerId,
        takeover: false,
        expectedControllerVersion: 1,
      })
    ).status,
  ).toBe(409);
  expect((await f.status(0)).status).toBe("waiting");
});

test("成立と競合した同じ操作元のheartbeatを成功とし、入室猶予は延長しない", async () => {
  const f = await fixture();
  await f.enqueueAll();
  const before = await runInDurableObject(
    f.stub,
    (_instance, state) =>
      state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!.groups[0]!.expiresAtMs,
  );
  expect(
    (await f.invoke(0, "queue", "PATCH", { operationId: f.operations[0]!.operationId })).status,
  ).toBe(200);
  expect(
    await runInDurableObject(
      f.stub,
      (_instance, state) =>
        state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!.groups[0]!
          .expiresAtMs,
    ),
  ).toBe(before);
});

test("旧owner無しの永続待機も本人だけが復旧でき、別ユーザー・Origin・旧payloadでは引き継げない", async () => {
  const f = await fixture(2),
    op = f.operations[0]!;
  await f.stub.enqueue(f.key, f.users[0]!.id, op.operationId, "ab".repeat(32));
  expect(await f.status(0)).toMatchObject({ controller: "other", controllerVersion: 0 });
  const claim = {
    operationId: op.operationId,
    controllerId: op.controllerId,
    takeover: true,
    expectedControllerVersion: 0,
  };
  expect((await f.invoke(1, "controller", "POST", claim)).status).toBe(409);
  expect(
    (
      await request(`/tournaments/${f.id}/controller`, {
        method: "POST",
        headers: { ...f.users[0]!.headers, Origin: "https://external.example" },
        body: JSON.stringify(claim),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(`/tournaments/${f.id}/queue`, {
        method: "DELETE",
        headers: f.users[0]!.headers,
        body: JSON.stringify({ operationId: op.operationId }),
      })
    ).status,
  ).toBe(400);
  expect((await f.invoke(0, "controller", "POST", claim)).status).toBe(200);
  expect(await f.status(0)).toMatchObject({ controller: "self", controllerVersion: 1 });
});

test("成立後の資格引継ぎは同じルームのまま旧tokenとsocketを失効し、猶予を延長しない", async () => {
  const f = await fixture(),
    op = f.operations[0]!;
  await f.enqueueAll();
  const first = await f.matchedController(0);
  const roomId = first.participation.roomId;
  const socket = await connect(roomId, first.token);
  const notice = returnNotice(socket);
  const expiresAtMs = await runInDurableObject(
    f.stub,
    (_instance, state) =>
      state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!.groups[0]!.expiresAtMs,
  );
  const claim = {
    operationId: op.operationId,
    controllerId: crypto.randomUUID(),
    takeover: true,
    expectedControllerVersion: 1,
  };
  const response = await f.invoke(0, "controller", "POST", claim);
  expect(response.status).toBe(200);
  const second = tournamentControllerResponseSchema.parse(await response.json());
  expect(second.participation).toMatchObject({
    status: "matched",
    roomId,
    instanceId: first.participation.instanceId,
    matchId: first.participation.matchId,
    controllerVersion: 2,
  });
  expect(await notice).toMatchObject({ reason: "transferred", tournamentId: f.id });
  expect(
    (
      await request(`/rooms/${roomId}/me`, {
        headers: { Authorization: `Bearer ${first.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(`/rooms/${roomId}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${first.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(`/rooms/${roomId}/me`, {
        headers: { Authorization: `Bearer ${second.token}` },
      })
    ).status,
  ).toBe(200);
  expect(
    await runInDurableObject(
      f.stub,
      (_instance, state) =>
        state.storage.kv.get<{ groups: { expiresAtMs: number }[] }>("state")!.groups[0]!
          .expiresAtMs,
    ),
  ).toBe(expiresAtMs);
  for (const method of ["PATCH", "DELETE"])
    expect((await f.invoke(0, "queue", method, { operationId: op.operationId })).status).toBe(409);
});

test("再鍵RPCの失敗を永続化してAlarmで回復し、古い世代の再送で新資格を戻さない", async () => {
  const f = await fixture(),
    op = f.operations[0]!;
  await f.enqueueAll();
  const original = await f.matchedController(0);
  const { roomId, matchId } = original.participation;
  await connect(roomId, original.token);
  await connect(roomId, f.operations[1]!.token);
  const claim = {
    operationId: op.operationId,
    controllerId: crypto.randomUUID(),
    takeover: true,
    expectedControllerVersion: 1,
  };
  await env.APP_DB.exec(
    "ALTER TABLE tournament_match_players RENAME TO tournament_players_unavailable",
  );
  try {
    const response = await f.invoke(0, "controller", "POST", claim);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("token");
    expect(
      (await env.GAME_ROOM.getByName(roomId).getTournamentReservationState(matchId!))
        .connectedPlayerIds,
    ).toHaveLength(2);
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        state.storage.kv
          .get<{
            groups: { players: { credentialPending: boolean; controllerVersion: number }[] }[];
          }>("state")!
          .groups[0]!.players.find((player) => player.controllerVersion === 2),
      ),
    ).toMatchObject({ credentialPending: true, controllerVersion: 2 });
  } finally {
    await env.APP_DB.exec(
      "ALTER TABLE tournament_players_unavailable RENAME TO tournament_match_players",
    );
  }
  await runDurableObjectAlarm(f.stub);
  const recoveredResponse = await f.invoke(0, "controller", "POST", claim);
  expect(recoveredResponse.status).toBe(200);
  const recovered = tournamentControllerResponseSchema.parse(await recoveredResponse.json());
  const group = await runInDurableObject(
    f.stub,
    (_instance, state) =>
      state.storage.kv.get<{
        groups: {
          id: string;
          roomId: string;
          instanceId: string;
          players: {
            accountId: string;
            tokenHash: string;
            admission: { accountId: string; operationId: string; playerId: string };
          }[];
        }[];
      }>("state")!.groups[0]!,
  );
  const player = group.players.find((player) => player.accountId === f.users[0]!.id)!;
  expect(
    await env.GAME_ROOM.getByName(group.roomId).rekeyTournamentPlayer({
      matchId: group.id,
      instanceId: group.instanceId,
      accountId: player.accountId,
      operationId: player.admission.operationId,
      playerId: player.admission.playerId,
      version: 1,
      tokenHash: "ab".repeat(32),
    }),
  ).toEqual({ status: "stale" });
  expect(
    (
      await request(`/rooms/${group.roomId}/me`, {
        headers: { Authorization: `Bearer ${original.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(`/rooms/${group.roomId}/me`, {
        headers: { Authorization: `Bearer ${recovered.token}` },
      })
    ).status,
  ).toBe(200);
});

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

test("旧版の確認待ちを休止後に復元し、全員未承諾でも同じ対局を自動準備する", async () => {
  const f = await fixture();
  const matchId = crypto.randomUUID(),
    instanceId = crypto.randomUUID();
  const roomId = nextUnusedRoomId();
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

test("本人状態の確認は他人の期限回収やAlarmの更新を行わない", async () => {
  const f = await fixture(2);
  await f.enqueueAll();
  const alarm = await runInDurableObject(f.stub, async (_instance, state) => {
    const stored = state.storage.kv.get<{
      waiting: { operationId: string; expiresAtMs: number }[];
    }>("state")!;
    stored.waiting.find((wait) => wait.operationId === f.operations[1]!.operationId)!.expiresAtMs =
      Date.now() - 1;
    state.storage.kv.put("state", stored);
    return state.storage.getAlarm();
  });
  const results = await Promise.all(Array.from({ length: 5 }, () => f.status(0)));
  for (const result of results) expect(result.status).toBe("waiting");
  expect((await f.status(1)).status).toBe("idle");
  await runInDurableObject(f.stub, async (_instance, state) => {
    expect(state.storage.kv.get<{ waiting: unknown[] }>("state")!.waiting).toHaveLength(2);
    expect(await state.storage.getAlarm()).toBe(alarm);
  });
  await runDurableObjectAlarm(f.stub);
  expect((await f.status(0)).status).toBe("waiting");
  expect((await f.status(1)).status).toBe("idle");
});

test("ルーム準備が失敗していても本人状態の確認と待機継続は再試行に巻き込まれない", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.enqueue(i);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test transfer fault'); END",
  );
  expect((await f.queue(3)).status).toBe(503);
  for (let i = 0; i < 4; i++) expect((await f.status(i)).status).toBe("waiting");
  await env.APP_DB.exec("DROP TRIGGER fail_tournament_transfer");
  await f.stub.refresh(f.key);
  for (let i = 0; i < 4; i++) expect((await f.status(i)).status).toBe("matched");
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

test("最後の待機継続から29秒で準備に失敗しても、30秒ちょうどで失効し再抽選から外れる", async () => {
  const f = await fixture();
  const now = Date.now();
  await f.enqueue(0);
  clock.mockReturnValue(now + 1000);
  const { operationId } = f.operations[0]!;
  await expectOk(await f.invoke(0, "queue", "PATCH", { operationId }), "準備前の待機継続");
  clock.mockReturnValue(now + 30_000);
  await f.enqueue(1);
  await f.enqueue(2);
  const prepare = vi
    .spyOn(tournamentRoomPreparation, "prepareTournamentRoom")
    .mockResolvedValueOnce({ status: "room_in_use" });
  try {
    await f.enqueue(3);
  } finally {
    prepare.mockRestore();
  }
  expect(await f.status(0)).toMatchObject({ status: "waiting", operationId });
  clock.mockReturnValue(now + 31_000);
  expect((await f.status(0)).status).toBe("idle");
  expect(await f.alarmTime()).toBe(Date.now());
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?")
      .bind(operationId)
      .first(),
  ).toBeNull();

  clock.mockReturnValue(now + 35_000);
  await f.stub.refresh(f.key);
  expect((await f.status(0)).status).toBe("idle");
  for (const i of [1, 2, 3]) expect((await f.status(i)).status).toBe("waiting");
});

async function suspendDuringPreparation(f: Awaited<ReturnType<typeof fixture>>) {
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test transfer fault'); END",
  );
  try {
    expect((await f.queue(3)).status).toBe(503);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_tournament_transfer");
  }
}

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

for (const phase of ["confirming", "preparing"] as const) {
  test(`保存済みの${phase}で操作元の待機継続を受け付け、準備失敗後に同じ操作を元の期限で復帰させる`, async () => {
    const f = await fixture();
    const now = Date.now();
    for (const i of [0, 1, 2]) await f.enqueue(i);
    clock.mockReturnValue(now + 29_000);
    await suspendDuringPreparation(f);
    const preparationDeadline = await runInDurableObject(f.stub, (_instance, state) => {
      const stored = state.storage.kv.get<State>("state")!;
      const group = stored.groups[0]!;
      group.phase = phase;
      state.storage.kv.put("state", stored);
      return group.expiresAtMs;
    });

    const { operationId } = f.operations[0]!;
    const lease = env.APP_DB.prepare(
      "SELECT lease_until_ms,match_operation_id FROM tournament_wait_reservations WHERE operation_id=?",
    ).bind(operationId);
    const preparationLease = await lease.first();
    expect(preparationLease).toMatchObject({ lease_until_ms: preparationDeadline });
    const alarmAt = await f.alarmTime();
    const heartbeatAt = now + 29_500;
    clock.mockReturnValue(heartbeatAt);
    expect(
      (await f.invoke(0, "queue", "PATCH", { operationId, controllerVersion: 0 })).status,
    ).toBe(409);
    const patch = await f.invoke(0, "queue", "PATCH", { operationId });
    await expectOk(patch, `${phase}の待機継続`);
    expect(await patch.json()).toEqual({ ok: true });
    expect(await f.alarmTime()).toBe(alarmAt);
    expect(await f.status(0)).toMatchObject({
      status: "waiting",
      expiresAtMs: preparationDeadline,
    });
    expect(await lease.first()).toEqual(preparationLease);

    const prepare = vi
      .spyOn(tournamentRoomPreparation, "prepareTournamentRoom")
      .mockResolvedValueOnce({ status: "room_in_use" });
    try {
      clock.mockReturnValue(now + 31_000);
      expect(await runDurableObjectAlarm(f.stub)).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      prepare.mockRestore();
    }
    const expiresAtMs = heartbeatAt + 30_000;
    expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
    expect((await f.status(1)).status).toBe("idle");
    expect((await f.status(2)).status).toBe("idle");
    clock.mockReturnValue(expiresAtMs - 1);
    expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
    clock.mockReturnValue(expiresAtMs);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await f.status(0)).status).toBe("idle");
    expect(await lease.first()).toBeNull();
  });
}

test("復帰用の期限がない旧形式の組は、準備期限まで元の操作で待機に戻る", async () => {
  const f = await fixture();
  const now = Date.now();
  for (const i of [0, 1, 2]) await f.enqueue(i);
  await suspendDuringPreparation(f);
  const expiresAtMs = await runInDurableObject(f.stub, (_instance, state) => {
    const stored = state.storage.kv.get<State>("state")!;
    const group = stored.groups[0]!;
    for (const player of group.players) delete player.waitingExpiresAtMs;
    state.storage.kv.put("state", stored);
    return group.expiresAtMs;
  });
  clock.mockReturnValue(now + 20_000);
  expect(
    (await f.invoke(3, "queue", "DELETE", { operationId: f.operations[3]!.operationId })).status,
  ).toBe(200);
  const { operationId } = f.operations[0]!;
  expect(await f.status(0)).toMatchObject({ status: "waiting", operationId, expiresAtMs });
  clock.mockReturnValue(expiresAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
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

test("待機の見直し中に期限が切れた予約を次のAlarmで回収する", async () => {
  const f = await fixture(2);
  const expiresAtMs = Date.now() + 30_000;
  await f.enqueue(0);
  const joinedAtMs = expiresAtMs - 1;
  clock.mockReturnValue(joinedAtMs);
  const finalize = tournamentStore.finalizeTournament;
  const finalizeWithClock = vi
    .spyOn(tournamentStore, "finalizeTournament")
    .mockImplementation(async (...args) => {
      await finalize(...args);
      // 待機の見直しを終えて次の予約を決めるまでに、参加者1の期限が切れます。
      clock.mockReturnValue(expiresAtMs);
    });
  try {
    await f.enqueue(1);
  } finally {
    finalizeWithClock.mockRestore();
  }

  const expiredLease = env.APP_DB.prepare(
    "SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?",
  ).bind(f.operations[0]!.operationId);
  expect(await expiredLease.first()).not.toBeNull();
  expect((await f.status(0)).status).toBe("idle");
  expect(await f.alarmTime()).toBe(expiresAtMs);

  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect(await expiredLease.first()).toBeNull();
  expect(await f.status(1)).toMatchObject({
    status: "waiting",
    expiresAtMs: joinedAtMs + 30_000,
  });
  expect(await f.alarmTime()).toBe(joinedAtMs + 30_000);
});

test("一人の待機継続で他の参加者の待機期限の回収を遅らせない", async () => {
  const f = await fixture(2);
  await f.enqueueAll();
  const expiresAtMs = Date.now() + 30_000;
  expect(await f.status(0)).toMatchObject({ status: "waiting", expiresAtMs });
  expect(await f.alarmTime()).toBe(expiresAtMs);

  clock.mockReturnValue(expiresAtMs - 1000);
  await expectOk(
    await f.invoke(1, "queue", "PATCH", { operationId: f.operations[1]!.operationId }),
    "参加者2の待機継続 PATCH",
  );
  expect(await f.alarmTime()).toBe(expiresAtMs);
  clock.mockReturnValue(expiresAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
  expect((await f.status(1)).status).toBe("waiting");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE operation_id=?")
      .bind(f.operations[0]!.operationId)
      .first(),
  ).toBeNull();
});

test("待機継続で大会終了時刻の待機回収と結果確定を遅らせない", async () => {
  const f = await fixture(1);
  const endsAtMs = Date.now() + 4000;
  await env.APP_DB.prepare("UPDATE tournaments SET ends_at_ms=? WHERE key=?")
    .bind(endsAtMs, f.key)
    .run();
  await f.enqueueAll();
  expect(await f.alarmTime()).toBe(endsAtMs);

  clock.mockReturnValue(endsAtMs - 1000);
  await expectOk(
    await f.invoke(0, "queue", "PATCH", { operationId: f.operations[0]!.operationId }),
    "参加者1の待機継続 PATCH",
  );
  expect(await f.alarmTime()).toBe(endsAtMs);
  clock.mockReturnValue(endsAtMs);
  expect(await runDurableObjectAlarm(f.stub)).toBe(true);
  expect((await f.status(0)).status).toBe("idle");
  expect(
    await env.APP_DB.prepare("SELECT finalized_at_ms FROM tournaments WHERE key=?")
      .bind(f.key)
      .first(),
  ).toEqual({ finalized_at_ms: endsAtMs });
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
