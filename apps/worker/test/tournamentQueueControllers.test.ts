import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import { tournamentControllerResponseSchema } from "@tetraboard/protocol";
import {
  useTournamentQueueFixtures,
  request,
  connect,
  returnNotice,
  fixture,
} from "./tournamentQueueFixtures";

useTournamentQueueFixtures();

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
