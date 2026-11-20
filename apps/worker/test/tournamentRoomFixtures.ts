import { type TournamentSettings } from "@tetraboard/protocol";
import { pendingMatchPrefix, type PendingMatch } from "../src/adapters/record/matchStore";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, vi } from "vitest";
import {
  isFourShogiRoom,
  roomSocketContract,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import type { PrepareTournamentRoomInput } from "@tetraboard/context-tournament";
import {
  pendingShogiMatchPrefix,
  type PendingShogiMatch,
} from "../src/adapters/record/shogiMatchStore";
import { releaseReservation } from "../src/adapters/room/seatReservations";
import type { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { unusedRoomId } from "./unusedRoomId";

type PreparedFixture = {
  input: PrepareTournamentRoomInput;
  tokens: string[];
  accounts: Awaited<ReturnType<typeof accountFixture>>[];
  stub: DurableObjectStub<GameRoom>;
  coordinator?: DurableObjectStub<
    import("../src/durableObjects/tournamentCoordinator/coordinator").TournamentCoordinator
  >;
};

export const sockets: WebSocket[] = [];

const fixtures: PreparedFixture[] = [];

export const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}${path}`, init));

export async function token() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { raw, hash };
}

export async function fixture(
  endsAfterMs = 3_600_000,
  settings?: TournamentSettings,
): Promise<PreparedFixture> {
  const now = Date.now();
  const tournamentKey = crypto.randomUUID();
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES (?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'大会',?,?,1,?,?)`)
    .bind(tournamentKey, now - 60_000, now + endsAfterMs, now, now)
    .run();
  const row = await env.APP_DB.prepare("SELECT public_id FROM tournaments WHERE key=?")
    .bind(tournamentKey)
    .first<{ public_id: number }>();
  const roomId = await unusedRoomId();
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
      env.APP_DB.prepare(
        "INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms,checked_at_ms) VALUES(?,?,?,?,?,?,?,?,0)",
      ).bind(
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
  if (settings) {
    await env.APP_DB.prepare(
      "UPDATE tournaments SET rule_version=2,game=?,settings_json=? WHERE key=?",
    )
      .bind(settings.game, JSON.stringify(settings), tournamentKey)
      .run();
    input.context = { ...input.context, ruleVersion: 2, settings };
  }
  const prepared = { input, tokens, accounts, stub: env.GAME_ROOM.getByName(roomId) };
  fixtures.push(prepared);
  return prepared;
}

export async function connect(roomId: string, credential: string) {
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

export async function connected(endsAfterMs?: number) {
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

export async function alarmAt(prepared: PreparedFixture, at: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await runDurableObjectAlarm(prepared.stub);
  } finally {
    clock.mockRestore();
  }
}

export async function playing() {
  const prepared = await connected();
  await alarmAt(prepared, prepared.startsAtMs);
  await prepared.clients[0]!.until(
    (message) => message.type === "room.snapshot" && message.room.status === "playing",
  );
  return prepared;
}

export async function flushSaves(prepared: Awaited<ReturnType<typeof fixture>>) {
  for (let index = 0; index < 4; index++) {
    await runInDurableObject(prepared.stub, async (_instance, state) => {
      for (const [key, job] of state.storage.kv.list<PendingShogiMatch>({
        prefix: pendingShogiMatchPrefix,
      }))
        state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
      for (const [key, job] of state.storage.kv.list<PendingMatch>({ prefix: pendingMatchPrefix }))
        state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(prepared.stub);
  }
}

export function useTournamentRoomFixtures() {
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
}
