import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { createRoomContract } from "@tetraboard/protocol";
import { readRegistrationFlow } from "../src/flows/guestRegistration/account";
import { applyMatchClaims } from "../src/flows/matchSave/claims";
import { accountFixture, origin } from "./accountFixtures";
import {
  credential,
  request,
  registrationRequest,
  bind,
  seedFlow,
  accountRequest,
  profileRequest,
  signIn,
  useRegistrationApiRooms,
} from "./registrationApiFixtures";

const { rooms, setup } = useRegistrationApiRooms();

test("開始資格の拒否と別Originでは未認証フローを残さず、資格は他人へ公開しない", async () => {
  const entry = await rooms().create({ game: "reversi", name: "ゲスト", quickPlay: false });
  const flow = credential();
  const body = {
    ...flow,
    instanceId: entry.room.instanceId,
    matchId: crypto.randomUUID(),
    newTokenHash: "ab".repeat(32),
  };
  const response = await request(`/rooms/${entry.room.id}/registration`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${"aa".repeat(32)}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(401);
  expect(await readRegistrationFlow(env.APP_DB, flow.registrationId)).toBeNull();
  expect(
    (
      await request(`/rooms/${entry.room.id}/registration`, {
        method: "POST",
        headers: { Origin: "https://evil.test" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect((await registrationRequest(flow, "")).status).toBe(401);
});

test("既存アカウントの古い席予約を回収後も同意済みの引継ぎで同じ席へ切り替える", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  await env.APP_DB.prepare(`INSERT INTO account_room_seats (account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms)
    VALUES (?,?,?,?,?,?,NULL,?)`)
    .bind(
      user.id,
      crypto.randomUUID(),
      "98456",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "登録名",
      Date.now() - 60_000,
    )
    .run();
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ record: "complete", seat: "complete" });
  prepared.entry.membership.token = prepared.nextToken;
});

test("未保存局の受付後は部屋閉鎖と1時間経過から独立して保存・再送できる", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  const stored = await env.APP_DB.prepare("SELECT * FROM matches WHERE id=?")
    .bind(prepared.matchId)
    .first<Record<string, string | number | null>>();
  expect(stored).not.toBeNull();
  await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(prepared.matchId).run();
  expect(
    (
      await request(`/rooms/${prepared.room.id}/leave`, {
        method: "POST",
        headers: { Origin: origin, Authorization: `Bearer ${prepared.entry.membership.token}` },
      })
    ).status,
  ).toBe(204);
  rooms().forgetClosedRoom(prepared.room.id);
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ record: "pending", seat: "unavailable" });
  await env.APP_DB.prepare("UPDATE registration_flows SET claim_until_ms=? WHERE id=?")
    .bind(Date.now(), prepared.flow.registrationId)
    .run();
  // 応答喪失時にはマーカー更新前でも帰属対応表が受付の正本になります。
  await env.APP_DB.prepare("UPDATE registration_flows SET record_accepted_at_ms=NULL WHERE id=?")
    .bind(prepared.flow.registrationId)
    .run();
  expect((await registrationRequest(prepared.flow, "complete", user.cookie)).status).toBe(200);
  const columns = Object.keys(stored!);
  await env.APP_DB.prepare(
    `INSERT INTO matches (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  )
    .bind(...columns.map((key) => stored![key]))
    .run();
  await applyMatchClaims(env.APP_DB, prepared.matchId);
  expect(await (await registrationRequest(prepared.flow, "", user.cookie)).json()).toMatchObject({
    record: "complete",
  });
});

test("受付期限ちょうどでは新規受付・OAuth・プロフィールを拒否する", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const user = await accountFixture(false);
  const flow = await seedFlow(user.cookie);
  await env.APP_DB.prepare("UPDATE registration_flows SET claim_until_ms=? WHERE id=?")
    .bind(Date.now(), flow.registrationId)
    .run();
  expect((await accountRequest(profileRequest(flow, user.cookie))).status).toBe(410);
  expect((await signIn(flow)).status).toBe(410);
  await env.APP_DB.prepare("UPDATE user SET profileCompleted=1 WHERE id=?").bind(user.id).run();
  await env.APP_DB.prepare("INSERT INTO legal_consents VALUES (?,?,?)")
    .bind(user.id, legalVersion, Date.now())
    .run();
  expect((await registrationRequest(flow, "complete", user.cookie)).status).toBe(410);
  expect(await (await registrationRequest(flow, "", user.cookie)).json()).toMatchObject({
    record: "expired",
  });
});

test("別ルームの使用中席は記録受付を妨げず、退室後の同じフローで席を切り替える", async () => {
  const prepared = await setup();
  const user = await accountFixture();
  await bind(prepared.flow, user.cookie);
  const elsewhere = createRoomContract.response.parse(
    await (
      await request("/rooms", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ game: "reversi", quickPlay: false }),
      })
    ).json(),
  );
  try {
    const response = await registrationRequest(prepared.flow, "complete", user.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ record: "complete", seat: "conflict" });
    expect(
      (
        await request(`/rooms/${elsewhere.room.id}/leave`, {
          method: "POST",
          headers: { Origin: origin, Authorization: `Bearer ${elsewhere.membership.token}` },
        })
      ).status,
    ).toBe(204);
    const retried = await registrationRequest(prepared.flow, "complete", user.cookie);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ record: "complete", seat: "complete" });
    prepared.entry.membership.token = prepared.nextToken;
    expect(
      await env.APP_DB.prepare(
        "SELECT COUNT(*) AS count FROM account_match_history WHERE account_id=? AND match_id=?",
      )
        .bind(user.id, prepared.matchId)
        .first(),
    ).toEqual({ count: 1 });
  } finally {
    await request(`/rooms/${elsewhere.room.id}/leave`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${elsewhere.membership.token}` },
    });
  }
});

test("元局に登録済みの別席があるアカウントには、保存前でも二席目を帰属させない", async () => {
  const user = await accountFixture();
  const prepared = await setup(user.cookie);
  await bind(prepared.flow, user.cookie);
  await env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id=?")
    .bind(prepared.matchId)
    .run();
  await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(prepared.matchId).run();
  const response = await registrationRequest(prepared.flow, "complete", user.cookie);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "conflict" });
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM match_participant_accounts WHERE match_id=?")
      .bind(prepared.matchId)
      .first(),
  ).toBeNull();
});
