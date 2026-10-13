import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gameIds, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { roomSchema, joinRoomContract } from "@tetraboard/protocol";
import { nextDueRoomDeadline } from "../src/rooms/roomDeadlines";
import { accountIdentity } from "../src/accounts/auth";
import { reserveAccountSeat } from "../src/accounts/roomAccounts";
import { requestDeletion } from "../src/privacy/deletion";
import { registrationKey, type StoredGuestRegistration } from "../src/rooms/registrationTypes";
import { accountFixture, origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures, type BoundarySocket } from "./roomBoundaryFixtures";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
async function digest(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
async function addPlayersAndStart(
  entry: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>,
  host: BoundarySocket,
  game: GameId,
) {
  const others = [];
  const clients = [host];
  for (let index = 1; index < gameCatalog[game].capacity; index++) {
    const other = await fixtures.join(entry.room.id, `参加${index}`);
    others.push(other);
    clients.push(await fixtures.connect(other));
  }
  for (const client of clients) client.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (message) => message.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
  return others;
}
async function finish(
  entry: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>,
  host: BoundarySocket,
  others: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>[],
) {
  for (const other of others) {
    const response = await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.membership.token}`, Origin: origin },
    });
    expect(response.status).toBe(204);
    fixtures.forgetDepartedPlayer(other.membership.playerId);
  }
  return (await host.waitFor("room.snapshot", (message) => message.room.lastRound !== null)).room;
}
async function setup(game: GameId = "reversi") {
  const entry = await fixtures.create({
    name: "ゲスト本人",
    game,
    quickPlay: false,
    ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
  });
  const host = await fixtures.connect(entry);
  const others = await addPlayersAndStart(entry, host, game);
  const room = await finish(entry, host, others);
  const last = room.lastRound!;
  const matchId = "roundId" in last ? last.roundId : last.replay!.id;
  const nextToken = "ab".repeat(32);
  const input = {
    registrationId: crypto.randomUUID(),
    instanceId: room.instanceId,
    matchId,
    oldTokenHash: await digest(entry.membership.token),
    newTokenHash: await digest(nextToken),
  };
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  return { entry, host, room, stub, input, nextToken };
}
async function admission(prepared: Awaited<ReturnType<typeof setup>>) {
  const user = await accountFixture();
  const request = new Request(`${origin}/api/rooms`, { headers: user.headers });
  const profile = await accountIdentity(request, env);
  const seat = await reserveAccountSeat(
    request,
    env,
    profile!,
    prepared.room,
    prepared.entry.membership.playerId,
    { reuseForGuestRegistration: true },
  );
  return { user, request, profile: profile!, seat };
}

for (const game of gameIds) {
  test(`${game}: 同じ席とホストで登録し、再送・新資格接続後の次局をアカウントで記録する`, async () => {
    const prepared = await setup(game);
    const { entry, host, stub, input, nextToken } = prepared;
    const started = await stub.beginGuestRegistration(input);
    expect(started.status).toBe("started");
    host.send({ type: "room.ready.set", ready: true });
    expect((await host.waitFor("room.error")).error).toBe("registration_pending");
    host.send({ type: "room.game.start" });
    expect((await host.waitFor("room.error")).error).toBe("registration_pending");
    const { user, request, profile, seat } = await admission(prepared);
    expect(
      await reserveAccountSeat(request, env, profile, prepared.room, entry.membership.playerId, {
        reuseForGuestRegistration: true,
      }),
    ).toMatchObject({ operationId: seat.operationId });
    const converted = await stub.completeGuestRegistration(input.registrationId, seat);
    expect(converted).toMatchObject({
      status: "converted",
      membership: { playerId: entry.membership.playerId, role: "host" },
    });
    expect(await stub.completeGuestRegistration(input.registrationId, seat)).toEqual(converted);
    expect(await stub.getRoomMembership(input.oldTokenHash)).toEqual({ status: "unauthorized" });
    entry.membership.token = nextToken;
    const connected = await fixtures.open(entry.room.id);
    connected.send({ type: "room.auth", token: nextToken });
    expect((await connected.waitFor("room.authenticated")).membership).toMatchObject({
      accountLinked: true,
    });
    const after = (await fixtures.snapshot(entry.room.id)).room;
    expect(after.players[0]).toMatchObject({
      id: entry.membership.playerId,
      name: "登録名",
      ready: false,
      reconnectDeadline: null,
    });
    expect(after.players[0]).not.toHaveProperty("registrationPendingUntilMs");
    const nextOthers = await addPlayersAndStart(entry, connected, game);
    await runInDurableObject(stub, (_instance, state) => {
      const key =
        game === "four-shogi"
          ? "shogi-match-start"
          : game === "shogi"
            ? "standard-shogi-match-start"
            : "match-start";
      const value = state.storage.kv.get<{
        participants: { id: string; accountId: string | null }[];
        start?: { participants: { id: string; accountId: string | null }[] };
      }>(key)!;
      const start = value.start ?? value;
      expect(start.participants.find((p) => p.id === entry.membership.playerId)?.accountId).toBe(
        user.id,
      );
      const analytics = state.storage.kv.get<{
        participants: { playerId: string; accountId: string | null }[];
      }>("analytics-active")!;
      expect(
        analytics.participants.find((p) => p.playerId === entry.membership.playerId)?.accountId,
      ).toBe(user.id);
    });
    await finish(entry, connected, nextOthers);
  });
}

test("OAuth中の切断30秒超・DO復元でも最後の席を保持し、取消で元の期限へ戻す", async () => {
  const { entry, host, stub, input } = await setup();
  const begun = await stub.beginGuestRegistration(input);
  expect(begun.status).toBe("started");
  host.close();
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(`disconnected-at:${entry.membership.playerId}`, Date.now() - 60_000);
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((p) => ({ ...p, reconnectDeadline: Date.now() - 30_000 })),
      }),
    );
  });
  await evictDurableObject(stub);
  expect(await stub.getGuestRegistration(input.registrationId)).toMatchObject({ state: "pending" });
  expect((await stub.getRoom())?.players[0].id).toBe(entry.membership.playerId);
  expect(await stub.cancelGuestRegistration(input.registrationId)).toMatchObject({
    state: "cancelled",
  });
  expect(await stub.getRoom()).toBeNull();
  fixtures.forgetClosedRoom(entry.room.id);
});

test("取消の遅延RPCを拒否し、新しい登録IDでも初回の期限を延長しない", async () => {
  const prepared = await setup();
  const { stub, input, entry } = prepared;
  const first = await stub.beginGuestRegistration(input);
  if (first.status !== "started") throw Error(first.status);
  const { seat } = await admission(prepared);
  await stub.cancelGuestRegistration(input.registrationId);
  expect(await stub.completeGuestRegistration(input.registrationId, seat)).toEqual({
    status: "cancelled",
  });
  expect(await stub.beginGuestRegistration(input)).toEqual({ status: "expired" });
  const second = await stub.beginGuestRegistration({
    ...input,
    registrationId: crypto.randomUUID(),
  });
  expect(second).toMatchObject({
    status: "started",
    registration: {
      playerId: entry.membership.playerId,
      startedAtMs: first.registration.startedAtMs,
      holdUntilMs: first.registration.holdUntilMs,
      claimUntilMs: first.registration.claimUntilMs,
    },
  });
  await stub.cancelAccountReservation(seat);
});

test("開始前の取消をDO復元後も保持し、遅れて到着した開始RPCで席を保持しない", async () => {
  const { stub, input, host, entry } = await setup();
  expect(await stub.cancelGuestRegistration(input.registrationId)).toBeNull();
  await evictDurableObject(stub);
  expect(await stub.beginGuestRegistration(input)).toEqual({ status: "expired" });
  expect(await stub.getGuestRegistration(input.registrationId)).toBeNull();
  expect((await stub.getRoom())?.players[0]).not.toHaveProperty("registrationPendingUntilMs");
  host.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (message) =>
    Boolean(message.room.players.find((p) => p.id === entry.membership.playerId)?.ready),
  );
});

test("保持期限を過ぎた登録完了で席を切り替えず、接続中のゲスト席は残す", async () => {
  const prepared = await setup();
  const { stub, input, entry } = prepared;
  await stub.beginGuestRegistration(input);
  const { seat } = await admission(prepared);
  await runInDurableObject(stub, (_instance, state) => {
    const record = state.storage.kv.get<StoredGuestRegistration>(
      registrationKey(input.registrationId),
    )!;
    state.storage.kv.put(registrationKey(input.registrationId), {
      ...record,
      holdUntilMs: Date.now() - 1,
    });
  });
  expect(await stub.completeGuestRegistration(input.registrationId, seat)).toEqual({
    status: "expired",
  });
  expect((await stub.getRoom())?.players[0]).toMatchObject({
    id: entry.membership.playerId,
    name: "ゲスト本人",
    ready: false,
  });
  expect(await stub.getRoomMembership(input.oldTokenHash)).toMatchObject({ status: "found" });
  await stub.cancelAccountReservation(seat);
});

test("10分後の新しい登録は初回1時間内の記録だけを受け付け、席保持を復活させない", async () => {
  const { stub, input, entry } = await setup();
  await stub.beginGuestRegistration(input);
  await stub.cancelGuestRegistration(input.registrationId);
  await runInDurableObject(stub, (_instance, state) => {
    const record = state.storage.kv.get<StoredGuestRegistration>(
      registrationKey(input.registrationId),
    )!;
    state.storage.kv.put(registrationKey(input.registrationId), {
      ...record,
      holdUntilMs: Date.now() - 1,
    });
  });
  const retry = { ...input, registrationId: crypto.randomUUID() };
  const created = await stub.beginGuestRegistration(retry);
  expect(created).toMatchObject({
    status: "started",
    registration: { state: "expired", playerId: entry.membership.playerId },
  });
  expect(await stub.beginGuestRegistration(retry)).toEqual(created);
  expect((await stub.getRoom())?.players[0]).not.toHaveProperty("registrationPendingUntilMs");
});

test("退会時は同じ席IDの未引き継ぎゲスト局を残し、登録参加した局だけ匿名化する", async () => {
  const prepared = await setup();
  const { stub, input, entry, nextToken } = prepared;
  const pendingOriginal = await runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.kv.get<{ record: unknown }>(`match-pending:${input.matchId}`)?.record ?? null,
  );
  const original = pendingOriginal
    ? { record_json: JSON.stringify(pendingOriginal) }
    : await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
        .bind(input.matchId)
        .first<{ record_json: string }>();
  expect(original).not.toBeNull();
  await stub.beginGuestRegistration(input);
  const { seat, user } = await admission(prepared);
  await stub.completeGuestRegistration(input.registrationId, seat);
  entry.membership.token = nextToken;
  const connected = await fixtures.open(entry.room.id);
  connected.send({ type: "room.auth", token: nextToken });
  await connected.waitFor("room.authenticated");
  const nextOthers = await addPlayersAndStart(entry, connected, "reversi");
  const finished = await finish(entry, connected, nextOthers);
  const staying = await fixtures.join(entry.room.id, "部屋に残る人");
  await fixtures.connect(staying);
  expect(
    (
      await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${nextToken}`, Origin: origin },
      })
    ).status,
  ).toBe(204);
  fixtures.forgetDepartedPlayer(entry.membership.playerId);
  const pendingKey = `match-pending:${input.matchId}`;
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.kv.put(pendingKey, {
      record: JSON.parse(original!.record_json),
      retryAtMs: Date.now() + 60_000,
    });
  });
  expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, (_instance, state) => {
    const pending = state.storage.kv.get<{ record: unknown }>(pendingKey)!;
    expect(pending.record).toEqual(JSON.parse(original!.record_json));
  });
  const result = (await fixtures.snapshot(entry.room.id)).room.lastRound!;
  expect(result.players.find((p) => p.id === entry.membership.playerId)?.name).toBe(
    "退会したプレイヤー",
  );
  expect(result.game).toEqual(finished.lastRound!.game);
});

test("非ホストを含む同時登録は各席を維持し、全員の切替と準備が終わるまで再戦させない", async () => {
  const hostEntry = await fixtures.create({ name: "ホスト", game: "reversi", quickPlay: false });
  const playerEntry = await fixtures.join(hostEntry.room.id, "参加者");
  const host = await fixtures.connect(hostEntry);
  const player = await fixtures.connect(playerEntry);
  host.send({ type: "room.ready.set", ready: true });
  player.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (message) => message.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const started = (
    await host.waitFor("room.snapshot", (message) => message.room.status === "playing")
  ).room;
  if (
    started.status !== "playing" ||
    started.settings.game !== "reversi" ||
    !("turn" in started.game)
  )
    throw Error("Expected playing room");
  const current = started.players.find((p) => "color" in p && p.color === started.game.turn)!;
  (current.id === hostEntry.membership.playerId ? host : player).send({ type: "room.game.resign" });
  const room = (await host.waitFor("room.snapshot", (message) => message.room.lastRound !== null))
    .room;
  const last = room.lastRound!;
  if (!("replay" in last)) throw Error("Expected event replay");
  const stub = env.GAME_ROOM.getByName(room.id);
  const inputs = await Promise.all(
    [hostEntry, playerEntry].map(async (entry, index) => ({
      registrationId: crypto.randomUUID(),
      instanceId: room.instanceId,
      matchId: last.replay!.id,
      oldTokenHash: await digest(entry.membership.token),
      newTokenHash: await digest((index ? "cd" : "ab").repeat(32)),
    })),
  );
  expect((await stub.beginGuestRegistration(inputs[0])).status).toBe("started");
  expect(
    await stub.beginGuestRegistration({ ...inputs[1], newTokenHash: inputs[0].newTokenHash }),
  ).toEqual({ status: "registration_conflict" });
  expect((await stub.beginGuestRegistration(inputs[1])).status).toBe("started");
  const initialOrder = room.players.map((p) => p.id);
  const hostAdmission = await admission({
    entry: hostEntry,
    host,
    room,
    stub,
    input: inputs[0],
    nextToken: "ab".repeat(32),
  });
  await stub.completeGuestRegistration(inputs[0].registrationId, hostAdmission.seat);
  hostEntry.membership.token = "ab".repeat(32);
  const newHost = await fixtures.open(room.id);
  newHost.send({ type: "room.auth", token: hostEntry.membership.token });
  await newHost.waitFor("room.authenticated");
  newHost.send({ type: "room.ready.set", ready: true });
  await newHost.waitFor("room.snapshot", (message) => Boolean(message.room.players[0].ready));
  newHost.send({ type: "room.game.start" });
  expect((await newHost.waitFor("room.error")).error).toBe("registration_pending");
  const playerAdmission = await admission({
    entry: playerEntry,
    host: player,
    room,
    stub,
    input: inputs[1],
    nextToken: "cd".repeat(32),
  });
  expect(
    await stub.completeGuestRegistration(inputs[1].registrationId, playerAdmission.seat),
  ).toMatchObject({
    status: "converted",
    membership: { role: "player", playerId: playerEntry.membership.playerId },
  });
  playerEntry.membership.token = "cd".repeat(32);
  const newPlayer = await fixtures.open(room.id);
  newPlayer.send({ type: "room.auth", token: playerEntry.membership.token });
  await newPlayer.waitFor("room.authenticated");
  const after = await fixtures.snapshot(room.id);
  expect(after.room.players.map((p) => p.id)).toEqual(initialOrder);
  expect(after.presence.hostPlayerId).toBe(hostEntry.membership.playerId);
  expect(after.room.players[1].ready).toBe(false);
  newPlayer.send({ type: "room.ready.set", ready: true });
  await newHost.waitFor("room.snapshot", (message) => message.room.players.every((p) => p.ready));
  newHost.send({ type: "room.game.start" });
  await newHost.waitFor("room.snapshot", (message) => message.room.status === "playing");
});

test("切替後の新資格は確定から30秒だけ待ち、完了再送で期限を延長せず失効後も復活しない", async () => {
  const prepared = await setup();
  const { stub, input, entry, nextToken } = prepared;
  await stub.beginGuestRegistration(input);
  const { seat } = await admission(prepared);
  await stub.completeGuestRegistration(input.registrationId, seat);
  entry.membership.token = nextToken;
  const before = await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    const disconnectedAt = state.storage.kv.get<number>(
      `disconnected-at:${entry.membership.playerId}`,
    )!;
    const deadline = room.players[0].reconnectDeadline!;
    return { disconnectedAt, deadline };
  });
  expect(before.deadline - before.disconnectedAt).toBe(30_000);
  const player = { id: entry.membership.playerId, reconnectDeadline: before.deadline };
  expect(nextDueRoomDeadline(null, [player], before.deadline - 1)).toBeNull();
  for (const at of [before.deadline, before.deadline + 1])
    expect(nextDueRoomDeadline(null, [player], at)).toEqual({
      type: "disconnect",
      at: before.deadline,
      playerId: player.id,
    });
  await stub.completeGuestRegistration(input.registrationId, seat);
  expect((await stub.getRoom())?.players[0].reconnectDeadline).toBe(before.deadline);
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(`disconnected-at:${player.id}`, Date.now() - 30_001);
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((p) => ({ ...p, reconnectDeadline: Date.now() - 1 })),
      }),
    );
  });
  expect(await stub.completeGuestRegistration(input.registrationId, seat)).toEqual({
    status: "released",
  });
  expect(await stub.getRoom()).toBeNull();
  expect(await stub.getRoomMembership(input.newTokenHash)).toEqual({ status: "not_found" });
  fixtures.forgetClosedRoom(entry.room.id);
});

test("前局にアカウント参加した別席が退室済みでも、保存待ちから同じアカウントの二席取得を拒否する", async () => {
  const entry = await fixtures.create({ name: "ゲスト", game: "reversi", quickPlay: false });
  const user = await accountFixture();
  const response = await boundaryRequest(`/rooms/${entry.room.id}/players`, {
    method: "POST",
    headers: user.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  const other = joinRoomContract.response.parse(await response.json());
  const host = await fixtures.connect(entry);
  const native = await fixtures.open(entry.room.id);
  native.send({ type: "room.auth", token: other.membership.token });
  await native.waitFor("room.authenticated");
  host.send({ type: "room.ready.set", ready: true });
  native.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
  await env.APP_DB.exec(
    `CREATE TRIGGER fail_native_claim_save BEFORE INSERT ON matches WHEN json_extract(NEW.record_json,'$.roomId')='${entry.room.id}' BEGIN SELECT RAISE(ABORT,'delayed save'); END`,
  );
  try {
    expect(
      (
        await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${other.membership.token}`, Origin: origin },
        })
      ).status,
    ).toBe(204);
    const room = (await host.waitFor("room.snapshot", (m) => m.room.lastRound !== null)).room;
    const last = room.lastRound!;
    if (!("replay" in last)) throw Error("Expected event replay");
    const matchId = last.replay!.id;
    const registrationId = crypto.randomUUID();
    const stub = env.GAME_ROOM.getByName(room.id);
    expect(
      (
        await stub.beginGuestRegistration({
          registrationId,
          matchId,
          instanceId: room.instanceId,
          oldTokenHash: await digest(entry.membership.token),
          newTokenHash: await digest("cd".repeat(32)),
        })
      ).status,
    ).toBe("started");
    expect(
      await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(matchId).first(),
    ).toBeNull();
    expect(await stub.validateGuestRegistrationAccount(registrationId, user.id)).toBe("conflict");
    expect(await stub.validateGuestRegistrationAccount(registrationId, crypto.randomUUID())).toBe(
      "eligible",
    );
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_native_claim_save");
  }
});
