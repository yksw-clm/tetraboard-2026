import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { roomSchema } from "@tetraboard/protocol";
import { nextDueRoomDeadline } from "@tetraboard/context-room";
import { registrationKey, type StoredGuestRegistration } from "../src/rooms/registrationTypes";
import { useGuestRegistrationRooms } from "./guestRegistrationRoomsFixtures";

const { rooms, setup, admission } = useGuestRegistrationRooms();

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
  rooms().forgetClosedRoom(entry.room.id);
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
  rooms().forgetClosedRoom(entry.room.id);
});
