import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm, applyD1Migrations } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  tournamentRules,
  tournamentControllerResponseSchema,
  roomSocketContract,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import type { PrepareTournamentRoomInput } from "../src/rooms/tournamentRoom";
import { writeTournamentState } from "../src/rooms/tournamentRoom";
import {
  pendingShogiMatchPrefix,
  type PendingShogiMatch,
  readShogiMatchRecord,
} from "../src/rooms/shogiMatchStore";
import { processDeletions, requestDeletion } from "../src/privacy/deletion";
import { releaseReservation } from "../src/accounts/roomAccounts";
import type { GameRoom } from "../src/rooms/gameRoom";

type PreparedFixture = {
  input: PrepareTournamentRoomInput;
  tokens: string[];
  accounts: Awaited<ReturnType<typeof accountFixture>>[];
  stub: DurableObjectStub<GameRoom>;
  coordinator?: DurableObjectStub<import("../src/tournaments/coordinator").TournamentCoordinator>;
};

const sockets: WebSocket[] = [];
const fixtures: PreparedFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const prepared of fixtures.splice(0)) {
    for (const player of prepared.input.players) await prepared.stub.leaveRoom(player.tokenHash);
    await prepared.stub.abortTournamentRoom(prepared.input.context.matchId);
    await flushSaves(prepared);
    for (const player of prepared.input.players)
      await releaseReservation(env, player.admission, true);
    await env.APP_DB.prepare(
      "UPDATE tournament_matches SET phase='aborted' WHERE id=? AND phase='reserved'",
    )
      .bind(prepared.input.context.matchId)
      .run();
    await runInDurableObject(prepared.stub, async (_instance, state) =>
      state.storage.deleteAlarm(),
    );
    if (prepared.coordinator) {
      for (const account of prepared.accounts)
        await prepared.coordinator.cancelForAccount(account.id);
      await runInDurableObject(prepared.coordinator, async (_instance, state) =>
        state.storage.deleteAlarm(),
      );
    }
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM tournament_point_events WHERE match_id=?").bind(
        prepared.input.context.matchId,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_match_players WHERE match_id=?").bind(
        prepared.input.context.matchId,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(
        prepared.input.context.tournamentKey,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE tournament_key=?").bind(
        prepared.input.context.tournamentKey,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_matches WHERE tournament_key=?").bind(
        prepared.input.context.tournamentKey,
      ),
      env.APP_DB.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(
        prepared.input.context.tournamentKey,
      ),
      env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(
        prepared.input.context.tournamentKey,
      ),
    ]);
  }
  for (const socket of sockets.splice(0)) socket.close();
});
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}${path}`, init));
async function token() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { raw, hash };
}
async function fixture(endsAfterMs = 3_600_000): Promise<PreparedFixture> {
  const now = Date.now();
  const tournamentKey = crypto.randomUUID();
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES (?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'大会',?,?,1,?,?)`)
    .bind(tournamentKey, now - 60_000, now + endsAfterMs, now, now)
    .run();
  const row = await env.APP_DB.prepare("SELECT public_id FROM tournaments WHERE key=?")
    .bind(tournamentKey)
    .first<{ public_id: number }>();
  const roomId = String(Math.floor(Math.random() * 100_000)).padStart(5, "0");
  const instanceId = crypto.randomUUID();
  const matchId = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO tournament_matches VALUES(?,?,?,?,'reserved',NULL,NULL,?)")
    .bind(matchId, tournamentKey, roomId, instanceId, now)
    .run();
  const input: PrepareTournamentRoomInput = {
    context: {
      tournamentId: row!.public_id,
      tournamentKey,
      matchId,
      startsAtMs: now - 60_000,
      endsAtMs: now + endsAfterMs,
      ruleVersion: 1,
    },
    roomId,
    instanceId,
    players: [],
  };
  const tokens: string[] = [];
  const accounts: Awaited<ReturnType<typeof accountFixture>>[] = [];
  for (let index = 0; index < 4; index++) {
    const account = await accountFixture();
    accounts.push(account);
    const entryId = crypto.randomUUID();
    const admission = {
      accountId: account.id,
      operationId: crypto.randomUUID(),
      roomId,
      instanceId,
      playerId: crypto.randomUUID(),
      name: "登録名",
      avatarKey: null,
    };
    const credential = await token();
    tokens.push(credential.raw);
    input.players.push({ admission, tokenHash: credential.hash });
    await env.APP_DB.batch([
      env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
        entryId,
        tournamentKey,
        account.id,
        now,
      ),
      env.APP_DB.prepare("INSERT INTO tournament_match_players VALUES(?,?,?,?,?)").bind(
        matchId,
        entryId,
        account.id,
        admission.playerId,
        admission.operationId,
      ),
      env.APP_DB.prepare("INSERT INTO account_room_seats VALUES(?,?,?,?,?,?,?,?,0)").bind(
        account.id,
        admission.operationId,
        roomId,
        instanceId,
        admission.playerId,
        admission.name,
        null,
        now,
      ),
      env.APP_DB.prepare("INSERT INTO privacy_room_accounts VALUES(?,?)").bind(account.id, roomId),
      env.APP_DB.prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)").bind(
        account.id,
        roomId,
        instanceId,
        admission.playerId,
      ),
    ]);
  }
  const prepared = { input, tokens, accounts, stub: env.GAME_ROOM.getByName(roomId) };
  fixtures.push(prepared);
  return prepared;
}
async function connect(roomId: string, credential: string) {
  const response = await request(`/api/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: RoomSocketMessage[] = [];
  const pending: ((message: RoomSocketMessage) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
    const receiver = pending.shift();
    if (receiver) receiver(message);
    else messages.push(message);
  });
  socket.accept();
  sockets.push(socket);
  async function until(
    predicate: (message: RoomSocketMessage) => boolean,
  ): Promise<RoomSocketMessage> {
    for (;;) {
      const message =
        messages.shift() ??
        (await new Promise<RoomSocketMessage>((resolve) => pending.push(resolve)));
      if (predicate(message)) return message;
    }
  }
  const send = (message: RoomSocketClientMessage) => socket.send(JSON.stringify(message));
  send({ type: "room.auth", token: credential });
  await until((message) => message.type === "room.authenticated");
  return { send, until, socket };
}
async function connected(endsAfterMs?: number) {
  const prepared = await fixture(endsAfterMs);
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  const clients = [];
  for (const credential of prepared.tokens)
    clients.push(await connect(prepared.input.roomId, credential));
  const countdown = await clients[0]!.until(
    (message) =>
      message.type === "room.snapshot" &&
      isFourShogiRoom(message.room) &&
      message.room.status === "waiting" &&
      message.room.tournamentStartsAtMs !== undefined,
  );
  if (
    countdown.type !== "room.snapshot" ||
    !isFourShogiRoom(countdown.room) ||
    countdown.room.status !== "waiting"
  )
    throw new Error("Missing tournament countdown");
  return { ...prepared, clients, startsAtMs: countdown.room.tournamentStartsAtMs! };
}

test("4人目の認証済み接続までは開始期限を作らず、認証前の接続を人数に含めない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  for (const credential of prepared.tokens.slice(0, 3))
    await connect(prepared.input.roomId, credential);
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  const response = await request(`/api/rooms/${prepared.input.roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  sockets.push(response.webSocket!);
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  await connect(prepared.input.roomId, prepared.tokens[3]!);
  await vi.waitFor(async () =>
    expect(await prepared.stub.getRoom()).toHaveProperty("tournamentStartsAtMs"),
  );
});

test("全員接続後も開始期限の直前までは待機し、永続化した期限のAlarmで一度だけ開始する", async () => {
  const prepared = await connected();
  const room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(room.status).toBe("waiting");
  expect(room).toHaveProperty("tournamentStartsAtMs", prepared.startsAtMs);
  expect(prepared.startsAtMs - room.lastActivityAtMs).toBeGreaterThanOrEqual(
    tournamentRules.startCountdownMs,
  );
  expect(
    await runInDurableObject(prepared.stub, (_instance, state) => state.storage.getAlarm()),
  ).toBe(prepared.startsAtMs);
  await alarmAt(prepared, prepared.startsAtMs - 1);
  expect(
    (await prepared.stub.getTournamentReservationState(prepared.input.context.matchId)).status,
  ).toBe("waiting");
  await alarmAt(prepared, prepared.startsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({
    status: "playing",
    startedAtMs: prepared.startsAtMs,
  });
  const started = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(started.status).toBe("playing");
  expect(started).not.toHaveProperty("tournamentStartsAtMs");
  await alarmAt(prepared, prepared.startsAtMs + 1);
  expect(fourShogiRoomSchema.parse(await prepared.stub.getRoom()).roundId).toBe(
    prepared.input.context.matchId,
  );
});

test("一人の最後の接続が切れると開始期限を解除し、全員の再接続から5秒を数え直す", async () => {
  const prepared = await connected();
  prepared.clients[3]!.socket.close();
  await prepared.clients[0]!.until(
    (message) =>
      message.type === "room.snapshot" &&
      isFourShogiRoom(message.room) &&
      message.room.status === "waiting" &&
      message.room.tournamentStartsAtMs === undefined &&
      !message.presence.connectedPlayerIds.includes(prepared.input.players[3]!.admission.playerId),
  );
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "waiting" });
  await alarmAt(prepared, prepared.startsAtMs);
  expect((await prepared.stub.getRoom())?.status).toBe("waiting");
  const clock = vi.spyOn(Date, "now").mockReturnValue(prepared.startsAtMs + 1000);
  let reconnectAt: number;
  try {
    await connect(prepared.input.roomId, prepared.tokens[3]!);
    const snapshot = await prepared.clients[0]!.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        message.room.status === "waiting" &&
        message.room.tournamentStartsAtMs !== undefined,
    );
    if (
      snapshot.type !== "room.snapshot" ||
      !isFourShogiRoom(snapshot.room) ||
      snapshot.room.status !== "waiting"
    )
      throw new Error("Missing reconnect countdown");
    reconnectAt = snapshot.room.tournamentStartsAtMs!;
    expect(reconnectAt).toBe(prepared.startsAtMs + 1000 + tournamentRules.startCountdownMs);
  } finally {
    clock.mockRestore();
  }
  await alarmAt(prepared, reconnectAt - 1);
  expect((await prepared.stub.getRoom())?.status).toBe("waiting");
  await alarmAt(prepared, reconnectAt);
  expect((await prepared.stub.getRoom())?.status).toBe("playing");
});

test("同じ参加資格の別接続が残っている間は開始期限を解除しない", async () => {
  const prepared = await connected();
  const duplicate = await connect(prepared.input.roomId, prepared.tokens[0]!);
  prepared.clients[0]!.socket.close();
  await vi.waitFor(async () => {
    const connections = await runInDurableObject(
      prepared.stub,
      (_instance, state) =>
        state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN).length,
    );
    expect(connections).toBe(4);
  });
  expect(await prepared.stub.getRoom()).toHaveProperty("tournamentStartsAtMs", prepared.startsAtMs);
  await alarmAt(prepared, prepared.startsAtMs);
  await duplicate.until(
    (message) => message.type === "room.snapshot" && message.room.status === "playing",
  );
});

test("操作元の引継ぎは旧接続を失効し開始期限を解除するが、同じ対局の新接続で再開できる", async () => {
  const prepared = await connected();
  const credential = await token();
  const player = prepared.input.players[0]!.admission;
  const rekey = {
    matchId: prepared.input.context.matchId,
    instanceId: prepared.input.instanceId,
    accountId: player.accountId,
    operationId: player.operationId,
    playerId: player.playerId,
    version: 1,
    tokenHash: credential.hash,
  };
  expect(await prepared.stub.rekeyTournamentPlayer(rekey)).toEqual({ status: "updated" });
  expect(
    await prepared.clients[0]!.until((message) => message.type === "room.tournament.return"),
  ).toMatchObject({ reason: "transferred", tournamentId: prepared.input.context.tournamentId });
  expect(await prepared.stub.getRoom()).not.toHaveProperty("tournamentStartsAtMs");
  expect(
    await prepared.stub.rekeyTournamentPlayer({
      ...rekey,
      tokenHash: prepared.input.players[0]!.tokenHash,
    }),
  ).toEqual({ status: "stale" });
  expect(await prepared.stub.rekeyTournamentPlayer(rekey)).toEqual({ status: "updated" });
  const now = prepared.startsAtMs + 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await connect(prepared.input.roomId, credential.raw);
    expect(await prepared.stub.getRoom()).toMatchObject({
      status: "waiting",
      instanceId: prepared.input.instanceId,
      tournamentStartsAtMs: now + tournamentRules.startCountdownMs,
    });
  } finally {
    clock.mockRestore();
  }
  prepared.input.players[0]!.tokenHash = credential.hash;
});

test("開始カウントダウンより大会締切が先なら、未開始で閉鎖して得点を付けない", async () => {
  const prepared = await connected(4000);
  expect(prepared.startsAtMs).toBeGreaterThan(prepared.input.context.endsAtMs);
  await alarmAt(prepared, prepared.input.context.endsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase,started_at_ms FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted", started_at_ms: null });
});

test("全員の接続が遅れても準備から30秒の期限を延長しない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  const reservation = await runInDurableObject(prepared.stub, (_instance, state) =>
    state.storage.kv.get<{ preparedAtMs: number }>(
      `tournament-reservation:${prepared.input.context.matchId}`,
    )!,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(reservation.preparedAtMs + 27000);
  try {
    for (const credential of prepared.tokens) await connect(prepared.input.roomId, credential);
    expect(await prepared.stub.getRoom()).toHaveProperty(
      "tournamentStartsAtMs",
      reservation.preparedAtMs + 32000,
    );
  } finally {
    clock.mockRestore();
  }
  await alarmAt(prepared, reservation.preparedAtMs + tournamentRules.connectionGraceMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
});

test("5秒待機中に参加資格が失われると、期限の再検証で開始を拒否する", async () => {
  const prepared = await connected();
  await env.APP_DB.prepare(
    "UPDATE tournament_entries SET deleted=1 WHERE tournament_key=? AND account_id=?",
  )
    .bind(prepared.input.context.tournamentKey, prepared.accounts[0]!.id)
    .run();
  await alarmAt(prepared, prepared.startsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase,started_at_ms FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted", started_at_ms: null });
});
async function alarmAt(prepared: PreparedFixture, at: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await runDurableObjectAlarm(prepared.stub);
  } finally {
    clock.mockRestore();
  }
}
async function playing() {
  const prepared = await connected();
  await alarmAt(prepared, prepared.startsAtMs);
  await prepared.clients[0]!.until(
    (message) => message.type === "room.snapshot" && message.room.status === "playing",
  );
  return prepared;
}
async function flushSaves(prepared: Awaited<ReturnType<typeof fixture>>) {
  for (let index = 0; index < 4; index++) {
    await runInDurableObject(prepared.stub, async (_instance, state) => {
      for (const [key, job] of state.storage.kv.list<PendingShogiMatch>({
        prefix: pendingShogiMatchPrefix,
      }))
        state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(prepared.stub);
  }
}

test("大会は4人接続後の5秒で固定IDの対局を一度だけ開始し、通常参加・設定・引分・再戦を拒否する", async () => {
  const prepared = await playing();
  const room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  expect(room.tournamentId).toBe(prepared.input.context.tournamentId);
  expect(room.roundId).toBe(prepared.input.context.matchId);
  expect(room.settings).toMatchObject({
    mode: "singles",
    timeControl: { mainTimeMs: 0, byoyomiMs: 30_000 },
    threePlayerAttackProhibited: true,
  });
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({
    status: "already_prepared",
  });
  expect(await prepared.stub.abortTournamentRoom(prepared.input.context.matchId)).toEqual({
    status: "already_started",
  });
  const join = await request(`/api/rooms/${room.id}/players`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "参加者" }),
  });
  expect(join.status).toBe(409);
  expect(await join.json()).toEqual({ error: "tournament_required" });
  const commands: RoomSocketClientMessage[] = [
    { type: "room.game.start" as const },
    {
      type: "room.time-control.set" as const,
      timeControl: { mainTimeMs: 60_000, byoyomiMs: 30_000 },
    },
    { type: "room.cpu.add" as const, level: 1 as const },
    {
      type: "room.game.draw.set" as const,
      proposed: true,
      roundId: prepared.input.context.matchId,
      positionRevision: 0,
    },
  ];
  for (const command of commands) {
    prepared.clients[0].send(command);
    expect(await prepared.clients[0].until((message) => message.type === "room.error")).toEqual({
      type: "room.error",
      error: "forbidden",
    });
  }
  expect(
    (await prepared.stub.getTournamentReservationState(prepared.input.context.matchId)).status,
  ).toBe("playing");
});

test("終局保存と大会得点を一括確定し、保存再送・閉鎖後も同局を二重加算しない", async () => {
  const prepared = await playing();
  await env.APP_DB.exec(
    "ALTER TABLE tournament_point_events RENAME TO tournament_points_unavailable",
  );
  let room = fourShogiRoomSchema.parse(await prepared.stub.getRoom());
  try {
    while (room.status === "playing") {
      const turn = room.game.turn;
      const player = room.players.find((candidate) => candidate.side === turn)!;
      const client =
        prepared.clients[
          prepared.input.players.findIndex((seat) => seat.admission.playerId === player.id)
        ]!;
      client.send({ type: "room.game.resign" });
      const previous = room.positionRevision;
      const message = await client.until(
        (value) =>
          value.type === "room.snapshot" &&
          isFourShogiRoom(value.room) &&
          ((value.room.status === "waiting" &&
            value.room.lastRound?.roundId === prepared.input.context.matchId) ||
            (value.room.status === "playing" &&
              "positionRevision" in value.room &&
              value.room.positionRevision > previous)),
      );
      if (message.type !== "room.snapshot") throw new Error("Missing room");
      room = fourShogiRoomSchema.parse(message.room);
    }
    await vi.waitFor(async () => {
      const jobs = await runInDurableObject(prepared.stub, (_instance, state) =>
        [...state.storage.kv.list<PendingShogiMatch>({ prefix: pendingShogiMatchPrefix })].map(
          ([, job]) => job,
        ),
      );
      expect(jobs.some((job) => job.retryAtMs > Date.now())).toBe(true);
    });
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM matches WHERE id=?")
        .bind(prepared.input.context.matchId)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id=?")
        .bind(prepared.input.context.matchId)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await env.APP_DB.exec(
      "ALTER TABLE tournament_points_unavailable RENAME TO tournament_point_events",
    );
  }
  await flushSaves(prepared);
  let saved: { record_json: string } | null = null;
  await vi.waitFor(async () => {
    saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first<{ record_json: string }>();
    expect(saved).not.toBeNull();
  });
  expect(readShogiMatchRecord(saved!.record_json).id).toBe(prepared.input.context.matchId);
  for (const phase of ["playing", "saving"] as const) {
    await writeTournamentState(env.APP_DB, {
      reservation: {
        context: prepared.input.context,
        roomId: prepared.input.roomId,
        instanceId: prepared.input.instanceId,
        status: "playing",
        preparedAtMs: Date.now(),
        startedAtMs: readShogiMatchRecord(saved!.record_json).startedAtMs,
      },
      phase,
      retryAtMs: Date.now(),
    });
  }
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "saved" });
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n,SUM(points_units) AS points FROM tournament_point_events WHERE match_id=?",
    )
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 4, points: 84 });
  prepared.coordinator = env.TOURNAMENT_COORDINATOR.getByName(prepared.input.context.tournamentKey);
  const entryIds = (
    await env.APP_DB.prepare("SELECT id,account_id FROM tournament_entries WHERE tournament_key=?")
      .bind(prepared.input.context.tournamentKey)
      .all<{ id: string; account_id: string }>()
  ).results;
  await runInDurableObject(prepared.coordinator, (_instance, state) => {
    state.storage.kv.put("state", {
      key: prepared.input.context.tournamentKey,
      waiting: [],
      groups: [
        {
          id: prepared.input.context.matchId,
          roomId: prepared.input.roomId,
          instanceId: prepared.input.instanceId,
          phase: "playing",
          expiresAtMs: Date.now() + 30000,
          players: prepared.input.players.map((player) => ({
            accountId: player.admission.accountId,
            operationId: player.admission.operationId,
            tokenHash: player.tokenHash,
            expiresAtMs: Date.now() + 30000,
            controllerId: crypto.randomUUID(),
            controllerVersion: 1,
            entryId: entryIds.find((entry) => entry.account_id === player.admission.accountId)!.id,
            admission: player.admission,
          })),
        },
      ],
    });
  });
  const recoveredResponse = await request(
    `/api/tournaments/${prepared.input.context.tournamentId}/controller`,
    {
      method: "POST",
      headers: prepared.accounts[0]!.headers,
      body: JSON.stringify({
        operationId: prepared.input.players[0]!.admission.operationId,
        controllerId: crypto.randomUUID(),
        takeover: true,
        expectedControllerVersion: 1,
      }),
    },
  );
  expect(recoveredResponse.status).toBe(200);
  const recovered = tournamentControllerResponseSchema.parse(await recoveredResponse.json());
  expect(recovered.participation.status).toBe("playing");
  expect(
    (
      await request(`/api/rooms/${room.id}/me`, {
        headers: { Authorization: `Bearer ${recovered.token}` },
      })
    ).status,
  ).toBe(200);
  prepared.tokens[0] = recovered.token;
  prepared.input.players[0]!.tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recovered.token)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  prepared.clients[1].send({ type: "room.game.start" });
  expect(await prepared.clients[1].until((message) => message.type === "room.error")).toEqual({
    type: "room.error",
    error: "forbidden",
  });
  for (const credential of prepared.tokens)
    expect(
      (
        await request(`/api/rooms/${room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
        })
      ).status,
    ).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_room_seats WHERE instance_id=?")
      .bind(prepared.input.instanceId)
      .first(),
  ).toEqual({ n: 0 });
  await flushSaves(prepared);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM tournament_point_events WHERE match_id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 4 });
});

test("未開始の取消は遅延prepareを防ぎ、準備済みの一人退室は4人全席を解放する", async () => {
  const cancelled = await fixture();
  expect(await cancelled.stub.abortTournamentRoom(cancelled.input.context.matchId)).toEqual({
    status: "cancelled",
  });
  expect(await cancelled.stub.prepareTournamentRoom(cancelled.input)).toEqual({
    status: "cancelled",
  });
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  expect(
    (
      await request(`/api/rooms/${prepared.input.roomId}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${prepared.tokens[0]}` },
      })
    ).status,
  ).toBe(204);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  await vi.waitFor(async () =>
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_room_seats WHERE room_id=?")
        .bind(prepared.input.roomId)
        .first(),
    ).toEqual({ n: 0 }),
  );
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted" });
});

test("締切ちょうどの未開始予約は閉鎖し、得点を付けない", async () => {
  const prepared = await fixture();
  expect(await prepared.stub.prepareTournamentRoom(prepared.input)).toEqual({ status: "prepared" });
  vi.spyOn(Date, "now").mockReturnValue(prepared.input.context.endsAtMs);
  expect(
    await prepared.stub.getTournamentReservationState(prepared.input.context.matchId),
  ).toMatchObject({ status: "closed" });
  expect(
    await env.APP_DB.prepare("SELECT phase FROM tournament_matches WHERE id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ phase: "aborted" });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM tournament_point_events WHERE match_id=?")
      .bind(prepared.input.context.matchId)
      .first(),
  ).toEqual({ n: 0 });
});

test("大会待機中の通常ルーム作成をaccount_busyで拒否し、退会は待機を削除して確定順位を匿名化する", async () => {
  const prepared = await fixture();
  const account = await accountFixture();
  const entryId = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(
      entryId,
      prepared.input.context.tournamentKey,
      account.id,
      Date.now(),
    ),
    env.APP_DB.prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)").bind(
      account.id,
      prepared.input.context.tournamentKey,
      crypto.randomUUID(),
      Date.now() + 30_000,
    ),
    env.APP_DB.prepare(
      "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,final_rank) VALUES(?,?,48,1,1,1)",
    ).bind(entryId, prepared.input.context.tournamentKey),
  ]);
  const result = await request("/api/rooms", {
    method: "POST",
    headers: { ...account.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ game: "four-shogi", quickPlay: false, mode: "singles" }),
  });
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ error: "account_busy" });
  const expired = await accountFixture();
  await env.APP_DB.prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)")
    .bind(expired.id, prepared.input.context.tournamentKey, crypto.randomUUID(), Date.now() - 1)
    .run();
  const admitted = await request("/api/rooms", {
    method: "POST",
    headers: { ...expired.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ game: "four-shogi", quickPlay: false, mode: "singles" }),
  });
  expect(admitted.status).toBe(201);
  const ordinary = (await admitted.json()) as {
    room: { id: string };
    membership: { token: string };
  };
  await request(`/api/rooms/${ordinary.room.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ordinary.membership.token}` },
  });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(expired.id)
      .first(),
  ).toBeNull();
  await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
    .bind(account.id)
    .run();
  const deletionDb = (env as unknown as { TOURNAMENT_PRIVACY_TEST_DB: D1Database })
    .TOURNAMENT_PRIVACY_TEST_DB;
  const migrations = (
    env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(deletionDb, migrations);
  const deleting = await accountFixture(true, crypto.randomUUID(), deletionDb);
  const deletingKey = crypto.randomUUID();
  const deletingEntry = crypto.randomUUID();
  await deletionDb.batch([
    deletionDb
      .prepare(
        "INSERT INTO tournaments(key,name,created_at_ms,updated_at_ms) VALUES(?,'退会対象大会',?,?)",
      )
      .bind(deletingKey, Date.now(), Date.now()),
    deletionDb
      .prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)")
      .bind(deletingEntry, deletingKey, deleting.id, Date.now()),
    deletionDb
      .prepare("INSERT INTO tournament_wait_reservations VALUES(?,?,?,?,NULL)")
      .bind(deleting.id, deletingKey, crypto.randomUUID(), Date.now() + 30_000),
    deletionDb
      .prepare(
        "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,final_rank) VALUES(?,?,48,1,1,1)",
      )
      .bind(deletingEntry, deletingKey),
  ]);
  const deletionEnv = { ...env, APP_DB: deletionDb };
  expect(await requestDeletion(deletionEnv, deleting.id, crypto.randomUUID())).toBe(true);
  expect(
    await deletionDb
      .prepare("SELECT deleted FROM tournament_entries WHERE id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ deleted: 1 });
  expect(
    await deletionDb
      .prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(deleting.id)
      .first(),
  ).toBeNull();
  await processDeletions(deletionEnv);
  expect(
    await deletionDb
      .prepare("SELECT account_id,deleted FROM tournament_entries WHERE id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ account_id: null, deleted: 1 });
  expect(
    await deletionDb
      .prepare("SELECT final_rank,points_units FROM tournament_scores WHERE entry_id=?")
      .bind(deletingEntry)
      .first(),
  ).toEqual({ final_rank: 1, points_units: 48 });
});
