import { adminAccountIds } from "../admin/auth";
import { accountRegisteredAtMsSql } from "../accounts/timestamps";
import { unsealToken } from "./tokens";
import type { AuthEnv } from "../accounts/auth";
import { avatarKeyPattern } from "../accounts/auth";
export const flowCookie = "tetraboard-2026.deletion-flow";
export const challengeCookie = "tetraboard-2026.deletion-challenge";
export const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function responseCookies(request: Request, response: Response) {
  const cookies = new Map(
    (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        const i = v.indexOf("=");
        return [v.slice(0, i), v.slice(i + 1)] as const;
      }),
  );
  for (const v of response.headers.getSetCookie()) {
    const pair = v.split(";")[0];
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const headers = new Headers(request.headers);
  headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  return headers;
}
export async function requestDeletion(env: AuthEnv, id: string, receipt: string) {
  const tokenHash = await digest(receipt);
  const reporterHash = await feedbackAccountHash(env, id);
  const results = await env.APP_DB.batch([
    env.APP_DB.prepare(`INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash,avatar_key,provider,revocation_token)
  SELECT u.id,?,?,u.avatarKey,a.providerId,a.accessToken FROM user u LEFT JOIN account a ON a.userId=u.id
  WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM account_room_seats s WHERE s.account_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id) LIMIT 1 RETURNING id`).bind(
      Date.now(),
      tokenHash,
      id,
    ),
    env.APP_DB.prepare(
      "UPDATE feedback SET deleted=1 WHERE reporter_hash=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(reporterHash, id, tokenHash),
    // 旧実装の席・保存待ちも確認するため、既存の部屋を対象に含めます。
    env.APP_DB.prepare(
      `INSERT OR IGNORE INTO deletion_rooms SELECT ?,room_id FROM room_index WHERE EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      `INSERT OR IGNORE INTO deletion_rooms SELECT account_id,room_id FROM privacy_room_accounts WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)`,
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      "DELETE FROM deletion_flows WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      "DELETE FROM deletion_challenges WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      "DELETE FROM tournament_wait_reservations WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(id, id, tokenHash),
    env.APP_DB.prepare(
      "UPDATE tournament_entries SET deleted=1 WHERE account_id=? AND EXISTS(SELECT 1 FROM deleted_accounts WHERE id=? AND receipt_hash=?)",
    ).bind(id, id, tokenHash),
  ]);
  return results[0].results.length === 1;
}
async function revoke(env: AuthEnv, provider: string | null, token: string | null) {
  if (!token) return;
  token = await unsealToken(env, token);
  let response: Response;
  if (provider === "google")
    response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    });
  else if (provider === "discord")
    response = await fetch("https://discord.com/api/oauth2/token/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${env.DISCORD_CLIENT_ID ?? ""}:${env.DISCORD_CLIENT_SECRET ?? ""}`)}`,
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    });
  else throw new Error("Unsupported provider");
  if (response.ok) return;
  if (response.status === 400) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (data?.error === "invalid_token") return;
  }
  throw new Error("Provider revocation failed");
}
export async function processDeletions(env: AuthEnv) {
  const jobs = await env.APP_DB.prepare(
    "SELECT id,avatar_key,provider,revocation_token FROM deleted_accounts WHERE completed_at_ms IS NULL ORDER BY last_attempted_at_ms,requested_at_ms LIMIT 10",
  ).all<{
    id: string;
    avatar_key: string | null;
    provider: string | null;
    revocation_token: string | null;
  }>();
  for (const job of jobs.results) {
    try {
      await env.APP_DB.prepare("UPDATE deleted_accounts SET last_attempted_at_ms=? WHERE id=?")
        .bind(Date.now(), job.id)
        .run();
      if (
        await env.APP_DB.prepare(
          "SELECT 1 FROM privacy_avatar_uploads WHERE account_id=? AND started_at_ms>? LIMIT 1",
        )
          .bind(job.id, Date.now() - 600000)
          .first()
      )
        continue;
      const rooms = await env.APP_DB.prepare(
        "SELECT room_id FROM deletion_rooms WHERE account_id=? LIMIT 100",
      )
        .bind(job.id)
        .all<{ room_id: string }>();
      for (const row of rooms.results) {
        await env.GAME_ROOM.getByName(row.room_id).purgeAccount(job.id);
        await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=? AND room_id=?")
          .bind(job.id, row.room_id)
          .run();
      }
      if (
        await env.APP_DB.prepare("SELECT 1 FROM deletion_rooms WHERE account_id=? LIMIT 1")
          .bind(job.id)
          .first()
      )
        continue;
      const tournaments = await env.APP_DB.prepare(
        "SELECT DISTINCT tournament_key FROM tournament_entries WHERE account_id=?",
      )
        .bind(job.id)
        .all<{ tournament_key: string }>();
      for (const tournament of tournaments.results)
        await env.TOURNAMENT_COORDINATOR.getByName(tournament.tournament_key).purgeAccount(job.id);
      await env.APP_DB.batch([
        env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?").bind(
          job.id,
        ),
        env.APP_DB.prepare(
          "UPDATE tournament_entries SET account_id=NULL,deleted=1 WHERE account_id=?",
        ).bind(job.id),
        env.APP_DB.prepare(
          "UPDATE tournament_match_players SET account_id=NULL WHERE account_id=?",
        ).bind(job.id),
      ]);
      // 受付の表示抑止と別に、本人の投稿本文・画像を物理削除します。
      const feedback = await env.APP_DB.prepare(
        "SELECT id,attachment_key FROM feedback WHERE reporter_hash=? OR account_id=?",
      )
        .bind(await feedbackAccountHash(env, job.id), job.id)
        .all<{ id: string; attachment_key: string | null }>();
      for (const row of feedback.results) {
        if (row.attachment_key) await env.OBJECT_STORAGE.delete(row.attachment_key);
        await env.APP_DB.batch([
          env.APP_DB.prepare("DELETE FROM feedback_history WHERE feedback_id=?").bind(row.id),
          env.APP_DB.prepare("DELETE FROM feedback WHERE id=?").bind(row.id),
          env.APP_DB.prepare("DELETE FROM feedback_uploads WHERE key=?").bind(
            row.attachment_key ?? "",
          ),
        ]);
      }
      if (job.avatar_key && avatarKeyPattern.test(job.avatar_key))
        await env.OBJECT_STORAGE.delete(job.avatar_key);
      const images = await env.APP_DB.prepare("SELECT key FROM deletion_images WHERE account_id=?")
        .bind(job.id)
        .all<{ key: string }>();
      for (const image of images.results) {
        await env.OBJECT_STORAGE.delete(image.key);
        await env.APP_DB.prepare("DELETE FROM deletion_images WHERE account_id=? AND key=?")
          .bind(job.id, image.key)
          .run();
      }
      await revoke(env, job.provider, job.revocation_token);
      await env.APP_DB.prepare("UPDATE deleted_accounts SET revocation_token=NULL WHERE id=?")
        .bind(job.id)
        .run();
      const reporterHash = await feedbackAccountHash(env, job.id);
      const owners = adminAccountIds(env) ?? [];
      const registeredAt = accountRegisteredAtMsSql();
      const registrations = [false, true].map((include) =>
        env.APP_DB.prepare(`INSERT INTO analytics_deleted_registrations(day,internal,count)
        SELECT strftime('%Y-%m-%d',(${registeredAt})/1000+32400,'unixepoch'),?,COUNT(*) FROM user u WHERE u.id=? AND COALESCE(u.isAnonymous,0)=0 AND (${registeredAt})>=COALESCE((SELECT value FROM analytics_metadata WHERE key='collected_from'),?) ${include ? "" : `AND COALESCE(u.isTestUser,0)=0 ${owners.length ? `AND u.id NOT IN (${owners.map(() => "?").join(",")})` : ""}`} GROUP BY 1,2
        ON CONFLICT(day,internal) DO UPDATE SET count=count+excluded.count`).bind(
          Number(include),
          job.id,
          Date.now(),
          ...(include ? [] : owners),
        ),
      );

      await env.APP_DB.batch([
        ...registrations,
        env.APP_DB.prepare(`DELETE FROM analytics_sessions WHERE account_id=?
          OR id IN (SELECT session_id FROM analytics_pageviews WHERE account_id=?)
          OR id IN (SELECT session_id FROM analytics_participants WHERE account_id=?)`).bind(
          job.id,
          job.id,
          job.id,
        ),
        env.APP_DB.prepare("DELETE FROM feedback_limits WHERE key IN (?,?)").bind(
          `${reporterHash}:600000`,
          `${reporterHash}:86400000`,
        ),
        env.APP_DB.prepare(
          "DELETE FROM analytics_dwell WHERE view_id IN (SELECT id FROM analytics_pageviews WHERE account_id=?)",
        ).bind(job.id),
        env.APP_DB.prepare("DELETE FROM analytics_pageviews WHERE account_id=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM analytics_participants WHERE account_id=?").bind(job.id),
        ...[
          "account_badge_awards",
          "account_badge_notifications",
          "account_match_history",
          "legal_consents",
          "privacy_room_accounts",
        ].map((t) => env.APP_DB.prepare(`DELETE FROM ${t} WHERE account_id=?`).bind(job.id)),
        env.APP_DB.prepare(
          "UPDATE privacy_room_players SET avatar_key=NULL WHERE account_id=?",
        ).bind(job.id),
        env.APP_DB.prepare("DELETE FROM privacy_avatar_uploads WHERE account_id=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM feedback_history WHERE admin_id=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM account WHERE userId=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM lobby_chat_messages WHERE account_id=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM lobby_chat_requests WHERE account_id=?").bind(job.id),
        env.APP_DB.prepare(
          "UPDATE lobby_chat_reports SET sender_name='退会したプレイヤー',sender_account_id=NULL,sender_public_id=NULL WHERE sender_account_id=?",
        ).bind(job.id),
        env.APP_DB.prepare(
          "UPDATE lobby_chat_reports SET reporter_account_id=NULL WHERE reporter_account_id=?",
        ).bind(job.id),
        env.APP_DB.prepare("DELETE FROM lobby_chat_senders WHERE account_id=?").bind(job.id),
        env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(job.id),
      ]);

      await env.APP_DB.prepare(
        "UPDATE deleted_accounts SET completed_at_ms=?,avatar_key=NULL,provider=NULL,revocation_token=NULL WHERE id=?",
      )
        .bind(Date.now(), job.id)
        .run();
    } catch {
      console.error("Account deletion will be retried");
    }
  }
}
async function feedbackAccountHash(env: AuthEnv, id: string) {
  const secret =
    env.FEEDBACK_HASH_SECRET ||
    (new URL(env.APP_ORIGIN).protocol === "http:"
      ? "feedback-local-only-secret-at-least-32-characters"
      : "");
  if (!secret) throw new Error("Feedback deletion is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`account:${id}`)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

export async function completeReauthentication(request: Request, response: Response, env: AuthEnv) {
  if (
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((value) => /^(?:__Secure-)?tetraboard-2026\.session_token=[^;]/.test(value))
  )
    return;
  const id = cookieValue(request, challengeCookie);
  if (!id) return;
  const state = new URL(request.url).searchParams.get("state");
  const row = await env.APP_DB.prepare(
    "SELECT account_id,provider,created_at_ms FROM deletion_challenges WHERE id=? AND oauth_state=? AND expires_at_ms>? AND verified_at_ms IS NULL",
  )
    .bind(id, state, Date.now())
    .first<{ account_id: string; provider: string; created_at_ms: number }>();
  if (!row || !new URL(request.url).pathname.endsWith(`/callback/${row.provider}`)) return;
  const { createAuth } = await import("../accounts/auth");
  const session = await createAuth(env).api.getSession({
    headers: responseCookies(request, response),
  });
  if (
    !session ||
    session.user.id !== row.account_id ||
    new Date(session.session.createdAt).getTime() < row.created_at_ms
  )
    return;
  await env.APP_DB.prepare(
    "UPDATE deletion_challenges SET verified_at_ms=?,verified_session_id=? WHERE id=? AND oauth_state=? AND verified_at_ms IS NULL",
  )
    .bind(Date.now(), session.session.id, id, state)
    .run();
}
