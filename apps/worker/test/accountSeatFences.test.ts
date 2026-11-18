import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { D1MatchmakingStore } from "../src/adapters/matchmaking/store";
import { ratedMatchmakingPolicy } from "../src/adapters/matchmaking/ratedMatchmaking";
import {
  readSeatFence,
  readMatchmakingWaitFence,
  readTournamentWaitFence,
  seatFence,
} from "../src/flows/accountSeats/fences";
import {
  fenceTriggers,
  fenceFixture,
  waiting,
  deleted,
  occupancy,
  type FenceFixture,
} from "./accountSeatFenceFixtures";

const db = env.APP_DB;
const reserve = (f: FenceFixture) => f.seat();

test("アプリへ移した参加フェンスは削除済みで、退会トリガーは残ります", async () => {
  const names = (
    await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all<{ name: string }>()
  ).results.map((r) => r.name);
  const removedTriggers = [
    ...fenceTriggers,
    "matchmaking_guest_merge_fence",
    "matchmaking_login_transition_fence",
    "guest_merged_seat_fence",
    "guest_merged_wait_fence",
    "guest_merged_entry_fence",
  ];
  expect(removedTriggers.filter((t) => names.includes(t))).toEqual([]);
  expect(names).toContain("privacy_fence_account_room_seats");
  expect(names).toContain("tournament_entry_deleted_fence");
});
for (const kind of ["matchmaking", "tournament"] as const) {
  test(`通常ルームは${kind}待機をaccount_busyで拒否します`, async () => {
    const f = await fenceFixture(db);
    await waiting(f, kind);
    await expect(reserve(f)).rejects.toMatchObject({ code: "account_busy", status: 409 });
    expect(await occupancy(f)).toEqual([kind]);
  });
  test(`${kind}待機の同じ席操作だけを許可します`, async () => {
    const f = await fenceFixture(db);
    const p = f.users[0]!.player;
    await waiting(f, kind);
    const table = `${kind}_wait_reservations`;
    const fence = seatFence("u.id", p.admission.operationId);
    for (const op of [null, "other", p.admission.operationId]) {
      await db
        .prepare(`UPDATE ${table} SET match_operation_id=? WHERE account_id=?`)
        .bind(op, p.accountId)
        .run();
      const result = await db
        .prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,created_at_ms)
        SELECT u.id,?,'12345',?,?,'登録名',1 FROM user u WHERE u.id=? AND ${fence.sql}`)
        .bind(
          p.admission.operationId,
          p.admission.instanceId,
          p.admission.playerId,
          p.accountId,
          ...fence.values,
        )
        .run();
      expect(result.meta.changes).toBe(op === p.admission.operationId ? 1 : 0);
      expect(await readSeatFence(db, p.accountId, p.admission.operationId)).toBe(
        op === p.admission.operationId ? null : `${kind}_waiting`,
      );
    }
  });
}
test(`通常ルームの既存席はaccount_seatedを保ちます`, async () => {
  const f = await fenceFixture(db);
  await reserve(f);
  await expect(reserve(f)).rejects.toMatchObject({ code: "account_seated", status: 409 });
  expect(await occupancy(f)).toEqual(["seat"]);
});
for (const blocker of ["seat", "tournament", "deleted", "merged"] as const) {
  test(`マッチング待機は${blocker}を例外で拒否します`, async () => {
    const f = await fenceFixture(db, blocker === "merged" ? 2 : 1);
    if (blocker === "seat") await reserve(f);
    else if (blocker === "tournament") await waiting(f, "tournament");
    else if (blocker === "deleted") await deleted(f);
    else {
      const guest = f.users[0]!,
        target = f.users[1]!;
      const session = await db
        .prepare("SELECT id FROM session WHERE userId=?")
        .bind(target.player.accountId)
        .first<{ id: string }>();
      const token = crypto.randomUUID();
      await db.batch([
        db
          .prepare("DELETE FROM tournament_entries WHERE account_id=?")
          .bind(guest.player.accountId),
        db.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.player.accountId),
        db
          .prepare(
            "INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,9999999999999)",
          )
          .bind(token, guest.player.accountId),
        db
          .prepare(
            "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id) VALUES(?,?,?,'google',0,9999999999999,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            guest.player.accountId,
            token,
            target.player.accountId,
            session!.id,
          ),
        db
          .prepare("INSERT INTO guest_account_merges VALUES(?,?,1)")
          .bind(guest.player.accountId, target.player.accountId),
      ]);
    }
    const reason =
      blocker === "deleted" || blocker === "merged" ? "account_deleted" : "account_busy";
    expect(await readMatchmakingWaitFence(db, f.users[0]!.player.accountId)).toBe(reason);
    await expect(waiting(f, "matchmaking")).rejects.toThrow(reason);
    expect(await occupancy(f)).not.toContain("matchmaking");
  });
}
test(`前局保存待ちはinserted:falseで競合は例外を保ちます`, async () => {
  const f = await fenceFixture(db);
  const p = f.users[0]!.player;
  const store = new D1MatchmakingStore(db, ratedMatchmakingPolicy("four-reversi"));
  await db
    .prepare("INSERT INTO skill_rating_pending(game,account_id,match_id) VALUES('four-shogi',?,?)")
    .bind(p.accountId, crypto.randomUUID())
    .run();
  try {
    expect(await store.join(p, "rated-test", "retired")).toEqual({
      inserted: false,
      latest: undefined,
    });
    await waiting(f, "tournament");
    await expect(store.join(p, "rated-test", "retired")).rejects.toThrow("account_busy");
  } finally {
    await db.prepare("DELETE FROM skill_rating_pending WHERE account_id=?").bind(p.accountId).run();
  }
});
for (const method of ["enqueue", "restore"] as const) {
  for (const blocker of ["seat", "deleted", "matchmaking"] as const) {
    test(`大会の${method}は${blocker}を例外で拒否します`, async () => {
      const f = await fenceFixture(db);
      if (blocker === "seat") await reserve(f);
      else if (blocker === "deleted") await deleted(f);
      else await waiting(f, "matchmaking");
      const reason =
        blocker === "seat"
          ? "account_seated"
          : blocker === "deleted"
            ? "account_deleted"
            : "matchmaking_waiting";
      expect(await readTournamentWaitFence(db, f.users[0]!.player.accountId)).toBe(reason);
      await expect(f.tournament[method](f.users[0]!.player, f.key)).rejects.toThrow(reason);
      expect(await occupancy(f)).not.toContain("tournament");
    });
  }
}
test(`restoreは挿入・同じ操作の更新・別操作の保持を保ちます`, async () => {
  const f = await fenceFixture(db),
    p = f.users[0]!.player;
  const row = () =>
    db
      .prepare(
        "SELECT operation_id,match_operation_id,lease_until_ms FROM tournament_wait_reservations WHERE account_id=?",
      )
      .bind(p.accountId)
      .first();
  await f.tournament.restore(p, f.key);
  expect(await row()).toEqual({
    operation_id: p.operationId,
    match_operation_id: null,
    lease_until_ms: p.expiresAtMs,
  });
  await db
    .prepare(
      "UPDATE tournament_wait_reservations SET match_operation_id='reserved' WHERE account_id=?",
    )
    .bind(p.accountId)
    .run();
  p.expiresAtMs += 1000;
  await f.tournament.restore(p, f.key);
  expect(await row()).toEqual({
    operation_id: p.operationId,
    match_operation_id: null,
    lease_until_ms: p.expiresAtMs,
  });
  await f.tournament.restore(
    { ...p, operationId: crypto.randomUUID(), expiresAtMs: p.expiresAtMs + 1000 },
    f.key,
  );
  expect(await row()).toEqual({
    operation_id: p.operationId,
    match_operation_id: null,
    lease_until_ms: p.expiresAtMs,
  });
});
test(`restoreは更新先の行があっても席のフェンスを優先します`, async () => {
  const f = await fenceFixture(db),
    p = f.users[0]!.player;
  await waiting(f, "tournament");
  const result = await db.batch(
    f.tournament
      .preparePlayer(
        p,
        {
          ...f.users[0]!.profile,
          isAnonymous: 0,
          entryId: p.entryId,
          operationId: p.operationId,
          avatarPresetId: null,
        },
        f.key,
      )
      .map((w) => w.value as D1PreparedStatement),
  );
  expect(result[1].meta.changes).toBe(1);
  await expect(f.tournament.restore(p, f.key)).rejects.toThrow("account_seated");
  expect(
    await db
      .prepare("SELECT match_operation_id FROM tournament_wait_reservations WHERE account_id=?")
      .bind(p.accountId)
      .first(),
  ).toEqual({ match_operation_id: p.admission.operationId });
});
for (const pair of ["seat-matchmaking", "seat-tournament", "matchmaking-tournament"] as const) {
  for (const reverse of [false, true]) {
    test(`${pair}の同時取得（逆順=${reverse}）は片方だけ成功します`, async () => {
      const f = await fenceFixture(db);
      const actions =
        pair === "seat-matchmaking"
          ? [() => reserve(f), () => waiting(f, "matchmaking")]
          : pair === "seat-tournament"
            ? [() => reserve(f), () => waiting(f, "tournament")]
            : [() => waiting(f, "matchmaking"), () => waiting(f, "tournament")];
      if (reverse) actions.reverse();
      const outcomes = await Promise.allSettled(actions.map((action) => action()));
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await occupancy(f)).toHaveLength(1);
    });
  }
}
