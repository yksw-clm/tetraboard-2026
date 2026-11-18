import { expect, test } from "vitest";
import { mergeGuestAccounts, promoteGuestLink } from "../src/flows/guestRegistration/guestLink";
import { guestLinkRoutes } from "../src/routes/guestLinkRoutes";
import {
  guestFenceDatabases,
  guestFenceFixture,
  guestFenceTriggers,
  heldGuestLink,
  withBatchInterleaving,
} from "./guestFenceFixtures";
import { readGuestLinkState, seedGuestTransfers } from "./guestLinkFenceState";

const cases = [
  { trigger: "guest_merge_fence", promote: false, code: "guest_merge_conflict" },
  { trigger: "matchmaking_guest_merge_fence", promote: false, code: "account_busy" },
  { trigger: "guest_promotion_fence", promote: true, code: "guest_promotion_conflict" },
  { trigger: "matchmaking_login_transition_fence", promote: true, code: "account_busy" },
  { trigger: "guest_room_link_commit_fence", promote: false, code: "guest_merge_conflict" },
] as const;
type FenceCase = (typeof cases)[number];
type Fixture = Awaited<ReturnType<typeof transitionFixture>>;
const conflictMessage =
  "引き継ぎできませんでした。同じ対局・大会への重複参加や参加中のルームを確認してください。";

async function transitionFixture(db: D1Database, promote: boolean) {
  const fixture = await guestFenceFixture(db, promote);
  const held = await heldGuestLink(db, fixture);
  await seedGuestTransfers(db, fixture, { ...held.registration, playerId: held.playerId });
  return { ...fixture, ...held };
}

async function block(db: D1Database, f: Fixture, scenario: FenceCase) {
  const { target, guest, registration } = f;
  if (scenario.code === "account_busy") {
    await db
      .prepare("INSERT INTO matchmaking_wait_reservations VALUES(?,'rated-test',?,?,NULL)")
      .bind(scenario.promote ? guest.id : target.id, crypto.randomUUID(), Date.now() + 60_000)
      .run();
  } else if (scenario.promote) {
    await db.prepare("UPDATE user SET profileCompleted=1 WHERE id=?").bind(target.id).run();
  } else if (scenario.trigger === "guest_room_link_commit_fence") {
    await db
      .prepare("UPDATE registration_flows SET session_id='stale' WHERE id=?")
      .bind(registration.registrationId)
      .run();
  } else {
    await db
      .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
      VALUES(?,?,'singles',1,'four-reversi')`)
      .bind(target.id, registration.matchId)
      .run();
  }
}

async function legacyTransition(db: D1Database, f: Fixture, promote: boolean) {
  const { guest, target, flow, registration, tokenHash } = f;
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO guest_room_link_commits VALUES(?,?,?,?,?)")
      .bind(registration.registrationId, guest.id, target.id, flow.state, now),
    promote
      ? db
          .prepare("INSERT INTO guest_promotions VALUES(?,?,?,?,?)")
          .bind(guest.id, target.id, tokenHash, flow.target_session_id, now)
      : db.prepare("INSERT INTO guest_account_merges VALUES(?,?,?)").bind(guest.id, target.id, now),
  ]);
}

for (const [index, { db, mode }] of guestFenceDatabases.entries()) {
  test(`${mode}のD1は対象トリガーだけを区別します`, async () => {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all<{ name: string }>();
    const names = rows.results.map(({ name }) => name);
    expect(guestFenceTriggers.filter((name) => names.includes(name))).toEqual(
      index === 0 ? guestFenceTriggers : [],
    );
    expect(names).toContain("privacy_fence_account_room_seats");
    expect(names).toContain("tournament_entry_deleted_fence");
  });

  for (const scenario of cases) {
    const { trigger, promote, code } = scenario;
    test(`${mode}で${trigger}は${code}を返し、付け替えを残しません`, async () => {
      const f = await transitionFixture(db, promote);
      await block(db, f, scenario);
      const before = await readGuestLinkState(db);
      if (index === 0) await expect(legacyTransition(db, f, promote)).rejects.toThrow(code);
      const transition = promote
        ? promoteGuestLink(f.request(), f.env, f.flow)
        : mergeGuestAccounts(f.env, f.flow);
      await expect(transition).rejects.toThrow(code);
      expect(await readGuestLinkState(db)).toEqual(before);
    });

    test(`${mode}で${trigger}のHTTP応答とCookieを保ちます`, async () => {
      const f = await transitionFixture(db, promote);
      await block(db, f, scenario);
      const response = await guestLinkRoutes.fetch(f.request(), f.env);
      expect(response.status).toBe(code === "account_busy" ? 503 : 409);
      expect(await response.json()).toEqual({ message: conflictMessage });
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  }

  for (const promote of [false, true]) {
    test(`${mode}で${promote ? "昇格" : "統合"}のbatch後に待機が消えてもaccount_busyを返します`, async () => {
      const f = await transitionFixture(db, promote);
      const scenario = cases[promote ? 3 : 1];
      const before = await readGuestLinkState(db);
      await block(db, f, scenario);
      const accountId = promote ? f.guest.id : f.target.id;
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

    test(`${mode}で${promote ? "昇格" : "統合"}の競合が重なるとaccount_busyを優先します`, async () => {
      const f = await transitionFixture(db, promote);
      await block(db, f, cases[promote ? 2 : 0]);
      await block(db, f, cases[promote ? 3 : 1]);
      if (index === 0)
        await expect(legacyTransition(db, f, promote)).rejects.toThrow("account_busy");
      await expect(
        promote ? promoteGuestLink(f.request(), f.env, f.flow) : mergeGuestAccounts(f.env, f.flow),
      ).rejects.toThrow("account_busy");
    });

    test(`${mode}で有効な保持席の${promote ? "昇格" : "統合"}が確定します`, async () => {
      const f = await transitionFixture(db, promote);
      if (promote) await promoteGuestLink(f.request(), f.env, f.flow);
      else await mergeGuestAccounts(f.env, f.flow);
      const registration = await db
        .prepare("SELECT account_id,record_accepted_at_ms FROM registration_flows WHERE id=?")
        .bind(f.registration.registrationId)
        .first();
      expect(registration).toMatchObject({
        account_id: promote ? f.guest.id : f.target.id,
        record_accepted_at_ms: promote ? null : expect.any(Number),
      });
      expect(
        await db
          .prepare("SELECT 1 FROM guest_room_link_commits WHERE registration_id=?")
          .bind(f.registration.registrationId)
          .first(),
      ).toBeNull();
    });
  }
}
