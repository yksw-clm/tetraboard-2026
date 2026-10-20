import { Hono } from "hono";
import { accountSessionIdentity, type AuthEnv, type StoredProfile } from "./auth";
import {
  guestIdentity,
  guestTokenHash,
  clearGuestSession,
  suspendGuestSession,
} from "./guestAccounts";
import { responseCookies } from "../privacy/deletion";
import { badgeAwardsSql } from "./badgeAwards";
import { guestChatMergeStatements } from "../lobby/mergeGuestChat";

export class GuestLinkError extends Error {}
export async function requireGuestIdle(env: Env, id: string) {
  const busy = await env.APP_DB.prepare(`SELECT 1 FROM account_room_seats WHERE account_id=?
    UNION ALL SELECT 1 FROM tournament_wait_reservations WHERE account_id=? LIMIT 1`)
    .bind(id, id)
    .first();
  if (busy)
    throw new GuestLinkError(
      "参加中のルームを退室し、大会の待機を取り消してから連携してください。",
    );
}
export async function prepareGuestLink(request: Request, env: Env) {
  if (
    /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
      request.headers.get("Cookie") ?? "",
    )
  )
    return null;
  const guest = await guestIdentity(request, env);
  if (guest) await requireGuestIdle(env, guest.id);
  return guest;
}
export async function rememberGuestLink(
  request: Request,
  env: Env,
  guest: StoredProfile,
  state: string,
  provider: string,
) {
  const now = Date.now();
  await env.APP_DB.prepare(
    "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?)",
  )
    .bind(state, guest.id, await guestTokenHash(request), provider, now, now + 600000)
    .run();
}
async function promoteGuestLink(request: Request, env: AuthEnv, flow: MergeFlow) {
  await requireGuestIdle(env, flow.guest_id);
  await requireGuestIdle(env, flow.target_id);
  const hash = await guestTokenHash(request);
  const created = await env.APP_DB.prepare("SELECT email FROM user WHERE id=?")
    .bind(flow.target_id)
    .first<{ email: string }>();
  if (!hash || !created) throw new GuestLinkError("連携の本人確認をやり直してください。");
  const source = flow.guest_id,
    target = flow.target_id;
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO guest_promotions VALUES(?,?,?,?,?)").bind(
      source,
      target,
      hash,
      flow.target_session_id,
      Date.now(),
    ),
    env.APP_DB.prepare("UPDATE user SET email=? WHERE id=?").bind(
      `${target}@transferred.invalid`,
      target,
    ),
    env.APP_DB.prepare(`UPDATE user SET email=?,emailVerified=(SELECT emailVerified FROM user WHERE id=?),
        isAnonymous=0,profileCompleted=0,guestRegisteredAt=?,updatedAt=? WHERE id=? AND isAnonymous=1
        AND EXISTS(SELECT 1 FROM guest_sessions WHERE token_hash=? AND account_id=? AND expires_at_ms>?)`).bind(
      created!.email,
      target,
      Date.now(),
      Date.now(),
      source,
      hash,
      source,
      Date.now(),
    ),
    env.APP_DB.prepare("UPDATE account SET userId=? WHERE userId=?").bind(source, target),
    env.APP_DB.prepare("UPDATE session SET userId=? WHERE userId=?").bind(source, target),
    env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(target),
    env.APP_DB.prepare("DELETE FROM guest_sessions WHERE account_id=?").bind(source),
    env.APP_DB.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=?").bind(source),
    env.APP_DB.prepare("DELETE FROM guest_promotions WHERE guest_id=?").bind(source),
  ]);
}

export async function completeGuestLink(request: Request, response: Response, env: AuthEnv) {
  if (
    new URL(request.url).searchParams.has("error") ||
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((cookie) => /^(?:__Secure-)?tetraboard-2026\.session_token=.+/.test(cookie))
  )
    return;
  const state = new URL(request.url).searchParams.get("state"),
    hash = await guestTokenHash(request);
  if (!hash) return;
  const identity = await accountSessionIdentity(
    new Request(request.url, { headers: responseCookies(request, response) }),
    env,
  );
  if (!identity) return;
  if (!state) {
    await suspendGuestSession(request, env);
    return;
  }
  const flow = await env.APP_DB.prepare(
    "SELECT * FROM guest_oauth_flows WHERE state=? AND guest_token_hash=? AND expires_at_ms>? AND target_id IS NULL",
  )
    .bind(state, hash, Date.now())
    .first<{ guest_id: string; provider: string; started_at_ms: number }>();
  if (!flow || !new URL(request.url).pathname.endsWith(`/callback/${flow.provider}`)) {
    await suspendGuestSession(request, env);
    return;
  }
  await env.APP_DB.prepare("UPDATE user SET publicProfileId=COALESCE(publicProfileId,?) WHERE id=?")
    .bind(crypto.randomUUID(), identity.user.id)
    .run();
  const created = await env.APP_DB.prepare("SELECT createdAt,email FROM user WHERE id=?")
    .bind(identity.user.id)
    .first<{ createdAt: number | string; email: string }>();
  const isNew =
    !identity.user.profileCompleted &&
    (typeof created?.createdAt === "string"
      ? Date.parse(created.createdAt)
      : (created?.createdAt ?? 0)) >= flow.started_at_ms;
  await env.APP_DB.prepare(
    "UPDATE guest_oauth_flows SET target_id=?,target_session_id=?,is_new_target=?,expires_at_ms=? WHERE state=? AND target_id IS NULL",
  )
    .bind(identity.user.id, identity.sessionId, Number(isNew), Date.now() + 3600000, state)
    .run();
  // 対応の保存後に確認専用へ切り替え、一時障害で元ゲストだけが先に失効することを防ぎます。
  await suspendGuestSession(request, env);
  // 初回登録でのみプロバイダーを元のゲストへ移し、内部IDを維持します。
  if (isNew) {
    try {
      await promoteGuestLink(request, env, {
        state,
        guest_id: flow.guest_id,
        target_id: identity.user.id,
        target_session_id: identity.sessionId,
        is_new_target: 1,
        name: "",
      });
      await clearGuestSession(request, env);
      return;
    } catch {
      // 別タブの参加や一時障害では認証応答を保ち、確認画面から再試行します。
      console.error("Guest promotion will be retried");
    }
  }
  response.headers.set("Location", "/account?guestMerge=1");
}
type MergeFlow = {
  state: string;
  guest_id: string;
  target_id: string;
  target_session_id: string;
  name: string;
  is_new_target: number;
};
async function mergeFlow(request: Request, env: AuthEnv): Promise<MergeFlow | null> {
  const identity = await accountSessionIdentity(request, env),
    hash = await guestTokenHash(request);
  if (!identity || !hash) return null;
  return env.APP_DB.prepare(`SELECT f.*,u.name FROM guest_oauth_flows f JOIN user u ON u.id=f.guest_id
    JOIN guest_sessions s ON s.token_hash=f.guest_token_hash AND s.account_id=f.guest_id
    WHERE f.guest_token_hash=? AND f.target_id=? AND f.target_session_id=? AND f.expires_at_ms>? AND s.expires_at_ms>?
    AND u.isAnonymous=1 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=f.guest_id)
    ORDER BY f.started_at_ms DESC LIMIT 1`)
    .bind(hash, identity.user.id, identity.sessionId, Date.now(), Date.now())
    .first<MergeFlow>();
}
export async function mergeGuestAccounts(env: Env, flow: MergeFlow) {
  const db = env.APP_DB,
    g = flow.guest_id,
    a = flow.target_id;
  const rooms = await db
    .prepare("SELECT room_id FROM privacy_room_accounts WHERE account_id=?")
    .bind(g)
    .all<{ room_id: string }>();
  for (const room of rooms.results)
    if (await env.GAME_ROOM.getByName(room.room_id).guestMergeConflict(g, a))
      throw new GuestLinkError("同じ対局で参加した複数の席の記録は統合できません。");
  const statements = [
    db.prepare(`INSERT INTO guest_account_merges VALUES(?,?,?)`).bind(g, a, Date.now()),
  ];
  // 公開棋譜の本人参照だけを移し、手順・日時・結果を保持します。
  for (const table of ["matches", "shogi_match_uploads"]) {
    for (const table of [
      "analytics_pageviews",
      "analytics_participants",
      "analytics_sessions",
      "analytics_session_visits",
      "feedback",
    ])
      statements.push(db.prepare(`UPDATE ${table} SET account_id=? WHERE account_id=?`).bind(a, g));
    statements.push(
      db
        .prepare(`UPDATE ${table} SET record_json=json_set(record_json,'$.participants',json((
      SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.accountId')=? THEN json_set(p.value,'$.accountId',?) ELSE p.value END))
      FROM json_each(${table}.record_json,'$.participants') p)))
      WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${table}.record_json) THEN ${table}.record_json ELSE '{}' END,'$.participants') p WHERE json_extract(p.value,'$.accountId')=?)`)
        .bind(g, a, g),
    );
  }
  statements.push(
    ...guestChatMergeStatements(db, g, a),
    db.prepare("UPDATE account_match_history SET account_id=? WHERE account_id=?").bind(a, g),
    db.prepare("UPDATE match_participant_accounts SET account_id=? WHERE account_id=?").bind(a, g),
    db.prepare("UPDATE tournament_entries SET account_id=? WHERE account_id=?").bind(a, g),
    db.prepare("UPDATE tournament_match_players SET account_id=? WHERE account_id=?").bind(a, g),
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_accounts SELECT ?,room_id FROM privacy_room_accounts WHERE account_id=?",
      )
      .bind(a, g),
    db
      .prepare(
        "INSERT OR IGNORE INTO privacy_room_players SELECT ?,room_id,instance_id,player_id,avatar_key FROM privacy_room_players WHERE account_id=?",
      )
      .bind(a, g),
    db.prepare("DELETE FROM privacy_room_accounts WHERE account_id=?").bind(g),
    db.prepare("DELETE FROM privacy_room_players WHERE account_id=?").bind(g),
    db
      .prepare(
        `INSERT OR IGNORE INTO account_badge_awards SELECT ?,game,badge_id,tier,value,previous_tier,match_id FROM account_badge_awards WHERE account_id=?`,
      )
      .bind(a, g),
    db
      .prepare(
        `INSERT OR IGNORE INTO account_badge_notifications SELECT ?,match_id,game,created_at_ms,shown_at_ms,NULL,NULL FROM account_badge_notifications WHERE account_id=?`,
      )
      .bind(a, g),
    db.prepare("DELETE FROM account_badge_awards WHERE account_id=?").bind(g),
    db.prepare("DELETE FROM account_badge_notifications WHERE account_id=?").bind(g),
    db.prepare(badgeAwardsSql("four-reversi", true, true)).bind("four-reversi", a),
    db.prepare(badgeAwardsSql("four-shogi", true, true)).bind("four-shogi", a),
    db.prepare("DELETE FROM guest_sessions WHERE account_id=?").bind(g),
    db.prepare("DELETE FROM session WHERE userId=?").bind(g),
    db.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=?").bind(g),
    db
      .prepare(
        "UPDATE user SET name='',username=NULL,profileCompleted=0,guestNameCustomized=0 WHERE id=?",
      )
      .bind(g),
  );
  await db.batch(statements);
}
export const guestLinkRoutes = new Hono<{ Bindings: AuthEnv }>();
guestLinkRoutes.use("/account/guest-merge", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
guestLinkRoutes.onError((err, c) =>
  c.json(
    {
      message:
        err instanceof GuestLinkError
          ? err.message
          : "引き継ぎできませんでした。同じ対局・大会への重複参加や参加中のルームを確認してください。",
    },
    err instanceof GuestLinkError ||
      /guest_merge_conflict|guest_promotion_conflict|UNIQUE constraint/.test(err.message)
      ? 409
      : 503,
  ),
);
guestLinkRoutes.get("/account/guest-merge", async (c) => {
  const flow = await mergeFlow(c.req.raw, c.env);
  return c.json({
    pending: flow
      ? { guestName: flow.name, ...(flow.is_new_target ? { isNewTarget: true } : {}) }
      : null,
  });
});
guestLinkRoutes.post("/account/guest-merge", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const flow = await mergeFlow(c.req.raw, c.env);
  if (!flow) return c.json({ message: "引き継ぎの本人確認をやり直してください。" }, 401);
  if (flow.is_new_target) await promoteGuestLink(c.req.raw, c.env, flow);
  else await mergeGuestAccounts(c.env, flow);
  await clearGuestSession(c.req.raw, c.env);
  return c.json({ merged: true });
});
guestLinkRoutes.delete("/account/guest-merge", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const flow = await mergeFlow(c.req.raw, c.env);
  if (flow) await clearGuestSession(c.req.raw, c.env);
  return c.json({ cancelled: true });
});
