import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  createRoomContract,
  joinRoomContract,
  listRoomsContract,
  type GameId,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { lobbyRoomCardsSchema, lobbyRoomsSchema } from "@tetraboard/protocol/general-lobby";
import worker from "../src/worker";
import { writeRoomIndex, type PendingRoomIndex } from "../src/rooms/roomIndex";
import { requestDeletion } from "../src/privacy/deletion";
import { mergeGuestAccounts } from "../src/accounts/guestLinking";
import { accountFixture, origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";

const db = (env as typeof env & { LOBBY_ROOM_CARDS_TEST_DB: D1Database }).LOBBY_ROOM_CARDS_TEST_DB;
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
const entries: ReturnType<typeof createRoomContract.response.parse>[] = [];
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (
      env as typeof env & {
        TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
      }
    ).TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  for (const entry of entries.splice(0).reverse()) {
    expect(
      (
        await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${entry.membership.token}`, Origin: origin },
        })
      ).status,
    ).toBe(204);
  }
  await fixtures.dispose();
  await db.batch(
    [
      "room_index",
      "privacy_room_accounts",
      "privacy_room_players",
      "deletion_rooms",
      "deleted_accounts",
      "guest_account_merges",
      "guest_oauth_flows",
      "guest_sessions",
      "legal_consents",
      "session",
      "user",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});
const request = (suffix = "", database = db) =>
  worker.fetch(
    new Request(`${origin}/api/lobby/rooms${suffix}`),
    { ...env, APP_DB: database },
    {} as ExecutionContext,
  );
async function cards(suffix = "", database = db) {
  const response = await request(`?view=cards${suffix}`, database);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return lobbyRoomCardsSchema.parse(await response.json());
}
function indexed(id: number, game: GameId, rank = 0): PendingRoomIndex {
  const capacity = gameCatalog[game].capacity;
  const metadata: RoomPublicMetadata = {
    id: String(id),
    game,
    ...(gameCatalog[game].hasModes
      ? { mode: id % 2 ? ("singles" as const) : ("doubles" as const) }
      : {}),
    timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
    status: rank === 2 ? "playing" : "waiting",
    hostName: "同じ名前",
    hostAvatarUrl: null,
    humanCount: rank === 0 ? 1 : capacity,
    cpuCount: 0,
    capacity,
    openSeats: rank === 0 ? capacity - 1 : 0,
    updatedAtMs: 1000,
  };
  return {
    revision: 1,
    closed: false,
    retryAtMs: 0,
    metadata: {
      ...metadata,
      instanceId: crypto.randomUUID(),
      hostPlayerId: crypto.randomUUID(),
      participantPreviews: Array.from({ length: metadata.humanCount }, () => ({
        playerId: crypto.randomUUID(),
        appearance: { kind: "human" as const, avatarUrl: null },
      })),
    },
  };
}

test("カード一覧は6ゲームを同じ優先順で20件ずつ返し、絞込後の全件数を返す", async () => {
  for (let index = 0; index < 30; index++) {
    await writeRoomIndex(db, indexed(10000 + index, gameIds[index % 6]!, index % 3));
  }
  const first = await cards();
  expect(first.totalCount).toBe(30);
  expect(first.rooms).toHaveLength(20);
  expect(first.rooms.slice(0, 10).every((room) => room.openSeats > 0)).toBe(true);
  expect(
    first.rooms.slice(10).every((room) => room.status === "waiting" && room.openSeats === 0),
  ).toBe(true);
  const second = await cards(`&cursor=${first.nextCursor}`);
  expect(second.totalCount).toBe(30);
  expect(second.rooms).toHaveLength(10);
  expect(second.rooms.every((room) => room.status === "playing")).toBe(true);
  expect(new Set([...first.rooms, ...second.rooms].map((room) => room.id)).size).toBe(30);
  const playable = await cards("&joinable=true");
  expect(playable.totalCount).toBe(10);
  expect(playable.rooms).toHaveLength(10);
  const twos = await cards("&capacity=2&joinable=false");
  expect(twos.totalCount).toBe(15);
  expect(twos.rooms.every((room) => room.capacity === 2)).toBe(true);
  const shogi = await cards("&game=four-shogi&mode=singles");
  expect(shogi.totalCount).toBe(5);
  expect(shogi.rooms.every((room) => room.game === "four-shogi" && room.mode === "singles")).toBe(
    true,
  );
  expect((await cards("&game=four-shogi&mode=doubles")).totalCount).toBe(0);
  expect((await cards("&game=four-shogi&capacity=2")).rooms).toHaveLength(0);
  for (const suffix of [
    "?view=cards&mode=standard",
    "?view=cards&joinable=1",
    "?view=cards&game=shogi&mode=singles",
    "?view=cards&cursor=3:100:12345",
    "?game=shogi",
  ]) {
    expect((await request(suffix)).status).toBe(400);
  }
});

test("旧一覧の形を維持し、cardsの各人間席には公開プロフィール参照だけを加える", async () => {
  const pending = indexed(12345, "four-reversi");
  const playerId = pending.metadata.participantPreviews![0]!.playerId;
  await writeRoomIndex(db, pending);
  const old = (await (await request()).json()) as { rooms: Record<string, unknown>[] };
  expect(lobbyRoomsSchema.parse(old).rooms).toHaveLength(1);
  expect(old).not.toHaveProperty("totalCount");
  expect(old.rooms[0]).not.toHaveProperty("participants");
  const legacy = await worker.fetch(
    new Request(`${origin}/api/rooms`),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
  expect(listRoomsContract.response.parse(await legacy.json()).rooms).toHaveLength(1);
  const page = await cards();
  expect(page.rooms[0]?.participants).toEqual([
    {
      kind: "human",
      avatarUrl: null,
      profileTarget: {
        source: "room",
        roomId: "12345",
        instanceId: pending.metadata.instanceId,
        playerId,
      },
    },
  ]);
  expect(page.rooms[0]?.profileTarget).toMatchObject({
    source: "room",
    playerId: pending.metadata.hostPlayerId,
  });
  expect(page.rooms[0]?.participants[0]).not.toHaveProperty("playerId");
  const stored = JSON.parse(
    (await db
      .prepare("SELECT participants_json FROM room_index WHERE room_id='12345'")
      .first<{ participants_json: string }>())!.participants_json,
  );
  expect(stored[0].appearance).not.toHaveProperty("profileTarget");
});

async function accountRoom() {
  const user = await accountFixture();
  const avatarId = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?")
    .bind(`avatars/${avatarId}.webp`, user.id)
    .run();
  const response = await boundaryRequest("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ quickPlay: false, mode: "singles" }),
  });
  expect(response.status).toBe(201);
  const entry = createRoomContract.response.parse(await response.json());
  entries.push(entry);
  return { user, avatarId, entry, stub: env.GAME_ROOM.getByName(entry.room.id) };
}
async function waitForIndex(
  id: string,
  predicate: (row: {
    revision: number;
    participants_json: string | null;
    updated_at_ms: number;
  }) => boolean,
) {
  let result!: { revision: number; participants_json: string | null; updated_at_ms: number };
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare(
      "SELECT revision,participants_json,updated_at_ms FROM room_index WHERE room_id=?",
    )
      .bind(id)
      .first<typeof result>();
    expect(row && predicate(row)).toBeTruthy();
    result = row!;
  });
  return result;
}

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

test("旧NULL索引はDO再作成後も公開時刻を変えず補完し、古い更新は新revisionを上書きしない", async () => {
  const { entry, avatarId, stub } = await accountRoom();
  const before = await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare(
    "UPDATE room_index SET participants_json=NULL,instance_id=NULL WHERE room_id=?",
  )
    .bind(entry.room.id)
    .run();
  await evictDurableObject(stub);
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(listed.instanceId).toBe(entry.room.instanceId);
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
  ]);
  const after = await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.updated_at_ms).toBe(before.updated_at_ms);
  await writeRoomIndex(env.APP_DB, {
    revision: before.revision,
    closed: false,
    retryAtMs: 0,
    metadata: { ...listed, hostName: "古いホスト" },
  });
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)?.hostName,
  ).toBe(listed.hostName);
});

test("補完では再利用された番号の現在世代をD1から読み直し、閉鎖済みの旧行は除外する", async () => {
  const { entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare(
    "UPDATE room_index SET participants_json=NULL,instance_id=? WHERE room_id=?",
  )
    .bind(crypto.randomUUID(), entry.room.id)
    .run();
  const corrected = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(corrected.instanceId).toBe(entry.room.instanceId);
  expect(
    (
      await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${entry.membership.token}` },
      })
    ).status,
  ).toBe(204);
  entries.splice(entries.indexOf(entry), 1);
  await vi.waitFor(async () => expect(await stub.getPublicMetadata()).toBeNull());
  await env.APP_DB.prepare("UPDATE room_index SET closed=0,participants_json=NULL WHERE room_id=?")
    .bind(entry.room.id)
    .run();
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id),
  ).toBeUndefined();
});

test("NULL補完はDOの応答をそのまま返さず、退会trigger適用後のD1画像を返す", async () => {
  const { user, avatarId, entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.prepare("UPDATE room_index SET participants_json=NULL WHERE room_id=?")
    .bind(entry.room.id)
    .run();
  // DOの削除処理より先に、D1側で退会が確定した状態を再現します。
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
  )
    .bind(user.id, Date.now(), crypto.randomUUID())
    .run();
  expect((await stub.getPublicMetadata())?.hostAvatarUrl).toBe(`/api/avatars/${avatarId}`);
  const listed = (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id)!;
  expect(listed.participants).toEqual([
    { kind: "human", avatarUrl: null, retired: true, profileTarget: null },
  ]);
  expect(listed.hostAvatarUrl).toBeNull();
  expect(listed.profileTarget).toBeNull();
});

test("補完のD1失敗は取得失敗として返し、既存の索引再送で復旧できる", async () => {
  const { entry, stub } = await accountRoom();
  await waitForIndex(entry.room.id, (row) => row.participants_json !== null);
  await env.APP_DB.exec("ALTER TABLE room_index RENAME TO lobby_room_index_unavailable");
  try {
    await stub.refreshLobbyIndex(entry.room.instanceId, 100);
    expect((await request("?view=cards", env.APP_DB)).status).toBe(503);
  } finally {
    await env.APP_DB.exec("ALTER TABLE lobby_room_index_unavailable RENAME TO room_index");
  }
  await runInDurableObject(stub, async (_instance, state) => {
    const pending = state.storage.kv.get<PendingRoomIndex>("room-index-pending")!;
    expect(pending.retryAtMs).toBeGreaterThan(Date.now());
    state.storage.kv.put("room-index-pending", { ...pending, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(
    (await cards("", env.APP_DB)).rooms.find((room) => room.id === entry.room.id),
  ).toBeDefined();
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
