import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import {
  roomCodeSchema,
  tournamentControllerResponseSchema,
  tournamentParticipationSchema,
  type TournamentParticipation,
} from "@tetraboard/protocol";
import * as tournamentRuntime from "../src/adapters/tournament/runtime";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { fixTestTime } from "./fixedTimeFixture";
import { createUnusedRoomIdAllocator } from "./unusedRoomId";

export const request = (path: string, init?: RequestInit) =>
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

export const roomCandidates: string[] = [];

export let roomIds: Awaited<ReturnType<typeof createUnusedRoomIdAllocator>>;

export let clock: ReturnType<typeof fixTestTime>;

export async function expectOk(response: Response, label: string) {
  const detail = response.status === 200 ? label : `${label} の応答本文 ${await response.text()}`;
  expect(response.status, detail).toBe(200);
}

export function requireMatched(participation: TournamentParticipation) {
  expect(participation, "対局成立後の参加状態").toMatchObject({ status: "matched" });
  return { ...participation, roomId: roomCodeSchema.parse(participation.roomId) };
}

export async function connect(roomId: string, token: string) {
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

export function returnNotice(socket: WebSocket) {
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

export async function fixture(count = 4) {
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

export async function suspendDuringPreparation(f: Awaited<ReturnType<typeof fixture>>) {
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_tournament_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test transfer fault'); END",
  );
  try {
    expect((await f.queue(3)).status).toBe(503);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_tournament_transfer");
  }
}

export function useTournamentQueueFixtures() {
  beforeEach(async () => {
    // 実時間で動くAlarmが手動実行より先に発火しないよう、基準を1時間先に置きます。
    clock = fixTestTime(Date.now() + 60 * 60 * 1000);
    roomCandidates.length = 0;
    roomIds = await createUnusedRoomIdAllocator();
    const createRuntime = tournamentRuntime.createTournamentRuntime;
    const runtime = vi
      .spyOn(tournamentRuntime, "createTournamentRuntime")
      .mockImplementation((...args) => ({
        ...createRuntime(...args),
        randomRoomId: () => roomCandidates.shift() ?? roomIds.next(),
      }));
    onTestFinished(() => runtime.mockRestore());
  });
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
}
