import { expect, test } from "vitest";
import { mergeGuestAccounts, promoteGuestLink } from "../src/flows/guestRegistration/guestLink";
import { guestLinkRoutes } from "../src/routes/guestLinkRoutes";
import {
  guestFenceDb as db,
  guestFenceFixture,
  heldGuestLink,
  withBatchInterleaving,
} from "./guestFenceFixtures";
import { readGuestLinkState, seedGuestTransfers } from "./guestLinkFenceState";

type Fixture = Awaited<ReturnType<typeof transitionFixture>>;
const conflictMessage =
  "引き継ぎできませんでした。同じ対局・大会への重複参加や参加中のルームを確認してください。";

async function transitionFixture(promote: boolean) {
  const fixture = await guestFenceFixture(db, promote);
  const held = await heldGuestLink(db, fixture);
  const chat = await seedGuestTransfers(db, fixture, {
    ...held.registration,
    playerId: held.playerId,
  });
  return { ...fixture, ...held, chat };
}

async function addMatchmakingWait(accountId: string) {
  await db
    .prepare("INSERT INTO matchmaking_wait_reservations VALUES(?,'rated-test',?,?,NULL)")
    .bind(accountId, crypto.randomUUID(), Date.now() + 60_000)
    .run();
}

async function addDuplicateHistory({ target, registration }: Fixture) {
  await db
    .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
    VALUES(?,?,'singles',1,'four-reversi')`)
    .bind(target.id, registration.matchId)
    .run();
}

async function completeTargetProfile({ target }: Fixture) {
  await db.prepare("UPDATE user SET profileCompleted=1 WHERE id=?").bind(target.id).run();
}

const cases = [
  {
    name: "同じ対局に参加済みのアカウントへの統合",
    promote: false,
    code: "guest_merge_conflict",
    block: addDuplicateHistory,
  },
  {
    name: "マッチング待機中のアカウントへの統合",
    promote: false,
    code: "account_busy",
    block: ({ target }: Fixture) => addMatchmakingWait(target.id),
  },
  {
    name: "プロフィール設定済みアカウントを使った昇格",
    promote: true,
    code: "guest_promotion_conflict",
    block: completeTargetProfile,
  },
  {
    name: "マッチング待機中のゲストの昇格",
    promote: true,
    code: "account_busy",
    block: ({ guest }: Fixture) => addMatchmakingWait(guest.id),
  },
  {
    name: "保持席の登録に古いセッションが残っている状態での統合",
    promote: false,
    code: "guest_merge_conflict",
    block: async ({ registration }: Fixture) => {
      await db
        .prepare("UPDATE registration_flows SET session_id='stale' WHERE id=?")
        .bind(registration.registrationId)
        .run();
    },
  },
] as const;

for (const { name, promote, code, block } of cases) {
  test(`${name}を${code}で拒否し、どの表も変更しません`, async () => {
    const f = await transitionFixture(promote);
    await block(f);
    const before = await readGuestLinkState(db);
    expect(before.lobby_chat_requests).toContainEqual({
      account_id: f.guest.id,
      request_id: f.chat.requestId,
      message_id: f.chat.messageId,
      body_hash: "hash",
      sent_at_ms: 1,
      tournament_id: null,
    });
    expect(before.lobby_chat_senders).toContainEqual({
      account_id: f.guest.id,
      public_id: f.guest.id,
      last_sent_at_ms: 1,
      stopped: 0,
    });
    const transition = promote
      ? promoteGuestLink(f.request(), f.env, f.flow)
      : mergeGuestAccounts(f.env, f.flow);
    await expect(transition).rejects.toThrow(code);
    expect(await readGuestLinkState(db)).toEqual(before);
  });

  test(`${name}をHTTPで拒否し、Cookieを維持します`, async () => {
    const f = await transitionFixture(promote);
    await block(f);
    const response = await guestLinkRoutes.fetch(f.request(), f.env);
    expect(response.status).toBe(code === "account_busy" ? 503 : 409);
    expect(await response.json()).toEqual({ message: conflictMessage });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
}

for (const promote of [false, true]) {
  test(`${promote ? "昇格" : "統合"}のbatch後に待機が消えてもaccount_busyを返します`, async () => {
    const f = await transitionFixture(promote);
    const before = await readGuestLinkState(db);
    const accountId = promote ? f.guest.id : f.target.id;
    await addMatchmakingWait(accountId);
    const afterReject = async () => {
      await db
        .prepare("DELETE FROM matchmaking_wait_reservations WHERE account_id=?")
        .bind(accountId)
        .run();
    };
    const env = { ...f.env, APP_DB: withBatchInterleaving(db, afterReject) };
    await expect(
      promote ? promoteGuestLink(f.request(), env, f.flow) : mergeGuestAccounts(env, f.flow),
    ).rejects.toThrow("account_busy");
    expect(
      await db
        .prepare("SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=?")
        .bind(accountId)
        .first(),
    ).toBeNull();
    expect(await readGuestLinkState(db)).toEqual(before);
  });

  test(`${promote ? "昇格" : "統合"}の競合が重なるとaccount_busyを優先します`, async () => {
    const f = await transitionFixture(promote);
    if (promote) await completeTargetProfile(f);
    else await addDuplicateHistory(f);
    await addMatchmakingWait(promote ? f.guest.id : f.target.id);
    const before = await readGuestLinkState(db);
    await expect(
      promote ? promoteGuestLink(f.request(), f.env, f.flow) : mergeGuestAccounts(f.env, f.flow),
    ).rejects.toThrow("account_busy");
    expect(await readGuestLinkState(db)).toEqual(before);
  });

  test(`有効な保持席の${promote ? "昇格" : "統合"}が確定します`, async () => {
    const f = await transitionFixture(promote);
    if (promote) await promoteGuestLink(f.request(), f.env, f.flow);
    else await mergeGuestAccounts(f.env, f.flow);
    const accountId = promote ? f.guest.id : f.target.id;
    const registration = await db
      .prepare("SELECT account_id,record_accepted_at_ms FROM registration_flows WHERE id=?")
      .bind(f.registration.registrationId)
      .first();
    expect(registration).toMatchObject({
      account_id: accountId,
      record_accepted_at_ms: promote ? null : expect.any(Number),
    });
    expect(
      await db
        .prepare("SELECT 1 FROM guest_room_link_commits WHERE registration_id=?")
        .bind(f.registration.registrationId)
        .first(),
    ).toBeNull();
    const { results: requests } = await db
      .prepare("SELECT account_id,message_id FROM lobby_chat_requests WHERE request_id=?")
      .bind(f.chat.requestId)
      .all();
    expect(requests).toEqual([{ account_id: accountId, message_id: f.chat.messageId }]);
    expect(
      await db
        .prepare("SELECT last_sent_at_ms FROM lobby_chat_senders WHERE account_id=?")
        .bind(accountId)
        .first(),
    ).toEqual({ last_sent_at_ms: 1 });
  });
}
