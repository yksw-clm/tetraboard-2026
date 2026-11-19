import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { joinRoomContract } from "@tetraboard/protocol";
import { writeRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { mergeGuestAccounts } from "../src/flows/guestRegistration/guestLink";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import {
  registerLobbyRoomCardsFixtures,
  fixtures,
  waitForIndex,
  cards,
  accountRoom,
  entries,
  db,
  indexed,
} from "./lobbyRoomCardsFixtures";

registerLobbyRoomCardsFixtures();

test("アカウントを持たない参加者も、各席の公開参照から既存プロフィールを表示できる", async () => {
  const entry = await fixtures.create({
    name: "旧ゲスト",
    game: "four-reversi",
    mode: "singles",
    quickPlay: false,
  });
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  const participant = listed.participants[0]!;
  if (participant.kind !== "human" || !participant.profileTarget)
    throw new Error("Missing guest profile target");
  const query = new URLSearchParams({ ...participant.profileTarget, game: listed.game });
  const response = await boundaryRequest(`/player-profile?${query}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "guest", name: "旧ゲスト", avatarUrl: null });
});

test("全席の画像・CPU・退室を索引へ反映し、プロフィール変更では入室時の画像を保つ", async () => {
  const { user, avatarId, entry, stub } = await accountRoom();
  const other = await accountFixture();
  const secondAvatar = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?")
    .bind(`avatars/${secondAvatar}.webp`, other.id)
    .run();
  const response = await boundaryRequest(`/rooms/${entry.room.id}/players`, {
    method: "POST",
    headers: other.headers,
    body: "{}",
  });
  expect(response.status).toBe(200);
  const joined = joinRoomContract.response.parse(await response.json());
  entries.push(joined);
  const host = await fixtures.open(entry.room.id);
  host.send({ type: "room.auth", token: entry.membership.token });
  await host.waitFor("room.authenticated");
  host.send({ type: "room.cpu.add", level: 2 });
  await host.waitFor("room.snapshot", (message) => message.room.players.length === 3);
  await waitForIndex(
    entry.room.id,
    (row) => JSON.parse(row.participants_json ?? "[]").length === 3,
  );
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?")
    .bind(`avatars/${crypto.randomUUID()}.webp`, user.id)
    .run();
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(listed.participants).toEqual([
    {
      kind: "human",
      avatarUrl: `/api/avatars/${avatarId}`,
      profileTarget: {
        source: "room",
        roomId: entry.room.id,
        instanceId: entry.room.instanceId,
        playerId: entry.membership.playerId,
      },
    },
    {
      kind: "human",
      avatarUrl: `/api/avatars/${secondAvatar}`,
      profileTarget: {
        source: "room",
        roomId: entry.room.id,
        instanceId: entry.room.instanceId,
        playerId: joined.membership.playerId,
      },
    },
    { kind: "cpu", level: 2 },
  ]);
  expect(JSON.stringify(listed)).not.toContain(user.id);
  expect(JSON.stringify(listed)).not.toContain(entry.membership.token);
  const participant = listed.participants[1]!;
  if (participant.kind !== "human" || !participant.profileTarget)
    throw new Error("Missing participant profile");
  const profileResponse = await boundaryRequest(
    `/player-profile?${new URLSearchParams({ ...participant.profileTarget, game: listed.game })}`,
  );
  expect(profileResponse.status).toBe(200);
  expect(await profileResponse.json()).toMatchObject({ kind: "account", username: other.username });
  expect(await stub.getPublicMetadata()).not.toHaveProperty("participantPreviews");
  const cpu = (await fixtures.snapshot(entry.room.id)).room.players.find(
    (player) => player.kind === "cpu",
  )!;
  host.send({ type: "room.cpu.remove", playerId: cpu.id });
  await host.waitFor("room.snapshot", (message) => message.room.players.length === 2);
  await waitForIndex(
    entry.room.id,
    (row) => JSON.parse(row.participants_json ?? "[]").length === 2,
  );
  expect(
    (
      await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.membership.token}` },
      })
    ).status,
  ).toBe(204);
  entries.splice(entries.indexOf(joined), 1);
  await waitForIndex(
    entry.room.id,
    (row) => JSON.parse(row.participants_json ?? "[]").length === 1,
  );
});

test("退会はホスト以外も直ちに匿名化し、遅い索引INSERTとUPDATEから画像を復活させない", async () => {
  const owner = await accountFixture(true, crypto.randomUUID(), db);
  const pending = indexed(12345, "four-reversi", 1);
  const participants = pending.metadata.participantPreviews!;
  participants.forEach((participant) => {
    if (participant.appearance.kind === "human")
      participant.appearance.avatarUrl = `/api/avatars/${crypto.randomUUID()}`;
  });
  const removed = participants[1]!;
  await db
    .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)")
    .bind(owner.id, "12345", pending.metadata.instanceId, removed.playerId)
    .run();
  await writeRoomIndex(db, pending);
  expect(await requestDeletion({ ...env, APP_DB: db }, owner.id, crypto.randomUUID())).toBe(true);
  for (const revision of [1, 2, 3]) {
    if (revision === 3) await db.prepare("DELETE FROM room_index WHERE room_id='12345'").run();
    if (revision > 1) await writeRoomIndex(db, { ...pending, revision });
    const listed = (await cards()).rooms[0]!;
    expect(listed.participants[1]).toEqual({
      kind: "human",
      avatarUrl: null,
      retired: true,
      profileTarget: null,
    });
    expect(listed.participants[0]).toMatchObject(participants[0]!.appearance);
    expect(listed.participants[0]).toHaveProperty(
      "profileTarget.playerId",
      participants[0]!.playerId,
    );
  }
});

test("ゲスト統合で移した席と旧ゲストaliasの席も、統合先の退会で匿名化する", async () => {
  const guest = await accountFixture(true, crypto.randomUUID(), db);
  const target = await accountFixture(true, crypto.randomUUID(), db);
  await db.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  const tokenHash = crypto.randomUUID();
  const session = await db
    .prepare("SELECT id FROM session WHERE userId=?")
    .bind(target.id)
    .first<{ id: string }>();
  const state = crypto.randomUUID();
  await db
    .prepare("INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)")
    .bind(tokenHash, guest.id, Date.now() + 60000)
    .run();
  await db
    .prepare(
      "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id,is_new_target) VALUES(?,?,?,'google',?,?,?,?,0)",
    )
    .bind(state, guest.id, tokenHash, Date.now(), Date.now() + 60000, target.id, session!.id)
    .run();
  const pending = indexed(12345, "four-reversi", 1);
  pending.metadata.participantPreviews![1]!.appearance = {
    kind: "human",
    avatarUrl: `/api/avatars/${crypto.randomUUID()}`,
  };
  const participant = pending.metadata.participantPreviews![1]!;
  await db
    .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)")
    .bind(guest.id, "12345", pending.metadata.instanceId, participant.playerId)
    .run();
  await writeRoomIndex(db, pending);
  await mergeGuestAccounts(
    { ...env, APP_DB: db },
    {
      state,
      guest_id: guest.id,
      target_id: target.id,
      target_session_id: session!.id,
      name: "ゲスト",
      is_new_target: 0,
    },
  );
  expect(
    await db
      .prepare("SELECT account_id FROM privacy_room_players WHERE player_id=?")
      .bind(participant.playerId)
      .first(),
  ).toEqual({ account_id: target.id });
  // 旧Worker由来のalias参照でも、統合先との対応を失いません。
  const aliasPlayer = pending.metadata.participantPreviews![2]!;
  aliasPlayer.appearance = { kind: "human", avatarUrl: `/api/avatars/${crypto.randomUUID()}` };
  await db
    .prepare("INSERT INTO privacy_room_players VALUES(?,?,?,?,NULL)")
    .bind(guest.id, "12345", pending.metadata.instanceId, aliasPlayer.playerId)
    .run();
  expect(await requestDeletion({ ...env, APP_DB: db }, target.id, crypto.randomUUID())).toBe(true);
  await writeRoomIndex(db, { ...pending, revision: 2 });
  const listed = (await cards()).rooms[0]!;
  expect(listed.participants[1]).toEqual({
    kind: "human",
    avatarUrl: null,
    retired: true,
    profileTarget: null,
  });
  expect(listed.participants[2]).toEqual({
    kind: "human",
    avatarUrl: null,
    retired: true,
    profileTarget: null,
  });
});
