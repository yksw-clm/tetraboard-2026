import { env, exports } from "cloudflare:workers";
import { challengeCookie, flowCookie } from "../src/adapters/privacy/deletionCookies";
import { processDeletions } from "../src/flows/accountPurge/processDeletions";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture, origin } from "./accountFixtures";

export const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, { redirect: "manual", ...init }));

// 削除待ちの他テストのアカウントを処理せず、本人の失敗・再試行だけを検証します。
export async function processFixtureDeletion(
  accountId: string,
  bindings: Parameters<typeof processDeletions>[0] = env,
) {
  const database = new Proxy(bindings.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (
            sql.startsWith("SELECT id,avatar_key,provider,revocation_token FROM deleted_accounts")
          )
            return target
              .prepare(sql.replace("completed_at_ms IS NULL", "completed_at_ms IS NULL AND id=?"))
              .bind(accountId);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await processDeletions({ ...bindings, APP_DB: database });
}

export async function tombstone(id: string) {
  return requestDeletion(env, id, crypto.randomUUID() + crypto.randomUUID());
}

export async function verified(
  user: Awaited<ReturnType<typeof accountFixture>>,
  expiry = Date.now() + 600000,
  db = env.APP_DB,
) {
  const challenge = crypto.randomUUID();
  const session = await db
    .prepare("SELECT id FROM session WHERE token=?")
    .bind(user.token)
    .first<{ id: string }>();
  await db
    .prepare(
      "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms,verified_at_ms,verified_session_id) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(challenge, user.id, "google", Date.now(), expiry, Date.now(), session!.id)
    .run();
  const flow = crypto.randomUUID();
  await db
    .prepare("INSERT INTO deletion_flows VALUES (?,?,?)")
    .bind(flow, user.id, Date.now() + 86400000)
    .run();
  return `${user.cookie}; ${challengeCookie}=${challenge}; ${flowCookie}=${flow}`;
}
