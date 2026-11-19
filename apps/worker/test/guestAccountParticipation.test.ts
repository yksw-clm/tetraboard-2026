import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import {
  avatarPresets,
  avatarPresetUrl,
  createRoomContract,
  joinRoomContract,
} from "@tetraboard/protocol";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { origin } from "./accountFixtures";
import { accountIdentity } from "../src/adapters/account/auth";
import { guest, request, trackGuestAccountRooms, link } from "./guestAccountsFixtures";

const createdRooms = trackGuestAccountRooms();

const createdTournaments: string[] = [];

afterEach(async () => {
  for (const key of createdTournaments.splice(0)) {
    const waiting = await env.APP_DB.prepare(
      "SELECT account_id FROM tournament_wait_reservations WHERE tournament_key=?",
    )
      .bind(key)
      .all<{ account_id: string }>();
    for (const row of waiting.results)
      await env.TOURNAMENT_COORDINATOR.getByName(key).cancelForAccount(row.account_id);
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM tournament_scores WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  }
});

async function tournament() {
  const key = crypto.randomUUID(),
    now = Date.now();
  const id = (await env.APP_DB.prepare(
    "SELECT COALESCE(MAX(public_id),0)+1 AS n FROM tournaments",
  ).first<{ n: number }>())!.n;
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,1,?,?)",
  )
    .bind(key, id, "ゲスト大会", now - 1000, now + 3600000, now, now)
    .run();
  createdTournaments.push(key);
  return { key, id };
}

for (const game of gameIds)
  test(`${game}: ゲスト本人として作成し、全ルーム共通1席制限を適用する`, async () => {
    const preset = avatarPresets[gameIds.indexOf(game)]!;
    const g = await guest("ゲスト本人", preset.id);
    expect(g.user.avatarPresetId).toBe(preset.id);
    const created = await request("/rooms", {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({
        game,
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    expect(created.status).toBe(201);
    const result = createRoomContract.response.parse(await created.json());
    createdRooms.add(result.room.id);
    expect(result.room.players[0]).toMatchObject({
      name: g.user.name,
      isGuest: true,
      avatarUrl: avatarPresetUrl(preset.id),
    });
    const duplicate = await request("/rooms", {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({
        game,
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(
      (
        await request("/auth/sign-in/social", {
          method: "POST",
          headers: g.headers,
          body: JSON.stringify({ provider: "google" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/rooms/${result.room.id}/leave`, {
          method: "POST",
          headers: { ...g.headers, Authorization: `Bearer ${result.membership.token}` },
        })
      ).status,
    ).toBe(204);
    const hostResponse = await request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game,
        name: "相手",
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
      }),
    });
    const host = createRoomContract.response.parse(await hostResponse.json());
    createdRooms.add(host.room.id);
    const joinedResponse = await request(joinRoomContract.pathFor(host.room.id), {
      method: "POST",
      headers: g.headers,
      body: JSON.stringify({ instanceId: host.room.instanceId }),
    });
    expect(joinedResponse.status).toBe(200);
    const joined = (await joinedResponse.json()) as {
      room: { players: { name: string; isGuest?: boolean }[] };
      membership: { token: string };
    };
    expect(joined.room.players.find((p) => p.name === g.user.name)).toMatchObject({
      isGuest: true,
      avatarUrl: avatarPresetUrl(preset.id),
    });
    await request(`/rooms/${host.room.id}/leave`, {
      method: "POST",
      headers: { ...g.headers, Authorization: `Bearer ${joined.membership.token}` },
    });
    await request(`/rooms/${host.room.id}/leave`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${host.membership.token}` },
    });
  });

test("ゲストも大会へエントリー・待機でき、同じ参加を重複登録しない", async () => {
  const g = await guest(),
    t = await tournament();
  for (let i = 0; i < 2; i++)
    expect(
      (await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: g.headers }))
        .status,
    ).toBe(200);
  expect(
    (
      await env.APP_DB.prepare(
        "SELECT id FROM tournament_entries WHERE tournament_key=? AND account_id=?",
      )
        .bind(t.key, g.id)
        .all()
    ).results,
  ).toHaveLength(1);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  expect(
    (
      await request(`/tournaments/${t.id}/queue`, {
        method: "POST",
        headers: g.headers,
        body: JSON.stringify({ operationId, controllerId, token: "ac".repeat(32) }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/auth/sign-in/social", {
        method: "POST",
        headers: g.headers,
        body: JSON.stringify({ provider: "google" }),
      })
    ).status,
  ).toBe(409);
  await env.TOURNAMENT_COORDINATOR.getByName(t.key).cancelForAccount(g.id);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM tournament_wait_reservations WHERE account_id=?")
      .bind(g.id)
      .first(),
  ).toBeNull();
});

test("大会エントリーと得点の同一性を保って統合し、同じ大会の二重エントリーは拒否する", async () => {
  const g = await guest(),
    t = await tournament();
  await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: g.headers });
  const entry = (await env.APP_DB.prepare(
    "SELECT id FROM tournament_entries WHERE tournament_key=? AND account_id=?",
  )
    .bind(t.key, g.id)
    .first<{ id: string }>())!.id;
  await env.APP_DB.prepare(
    "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first) VALUES(?,?,10,1,1)",
  )
    .bind(entry, t.key)
    .run();
  const linked = await link(g);
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(
    await env.APP_DB.prepare("SELECT account_id FROM tournament_entries WHERE id=?")
      .bind(entry)
      .first(),
  ).toEqual({ account_id: linked.target.id });
  expect(
    await env.APP_DB.prepare("SELECT points_units,games FROM tournament_scores WHERE entry_id=?")
      .bind(entry)
      .first(),
  ).toEqual({ points_units: 10, games: 1 });
  const other = await guest();
  expect(
    (await request(`/tournaments/${t.id}/entries`, { method: "POST", headers: other.headers }))
      .status,
  ).toBe(200);
  const conflict = await link(other);
  await request(`/tournaments/${t.id}/entries`, {
    method: "POST",
    headers: conflict.target.headers,
  });
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: conflict.headers })).status,
  ).toBe(409);
  expect(await accountIdentity(new Request(origin, { headers: other.headers }), env)).toBeNull();
  expect(
    await (await request("/account/guest-merge", { headers: conflict.headers })).json(),
  ).toMatchObject({ pending: { guestName: other.user.name } });
});
