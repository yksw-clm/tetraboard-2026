import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { expect, test } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  accountIdentity,
  accountSessionIdentity,
  createAuth,
  withAccountSessionCookies,
  type AuthEnv,
} from "../src/accounts/auth";
import { createGuestAccount } from "../src/accounts/guestAccounts";
import { accountFixture, origin } from "./accountFixtures";

function observeDatabase(db: D1Database) {
  const queries: string[] = [];
  const database = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database,
    queries,
    schemaQueries: () => [
      ...new Set(queries.filter((sql) => /sqlite_master|pragma_table_info/i.test(sql))),
    ],
  };
}

function bindings(secure: boolean): AuthEnv {
  return { ...env, APP_ORIGIN: secure ? "https://tetraboard.net" : origin };
}

async function guest(bindings: AuthEnv) {
  const request = new Request(bindings.APP_ORIGIN, {
    headers: { Origin: bindings.APP_ORIGIN, "X-Legal-Consent": legalVersion },
  });
  let id = "";
  const response = await withAccountSessionCookies(request, async () => {
    id = (await createGuestAccount(request, bindings)).id;
    return new Response(null);
  });
  return { id, cookie: response.headers.getSetCookie()[0]!.split(";")[0]! };
}

for (const secure of [false, true]) {
  const protocol = secure ? "HTTPS" : "HTTP";

  // 修正前は各インスタンスの構造確認SQLが残り、このアサーションで失敗します。
  test(`${protocol}: 認証インスタンスを作り直しても構造確認SQLを発行しない`, async () => {
    const user = await accountFixture();
    const measured = observeDatabase(env.APP_DB);
    const authEnv = { ...bindings(secure), APP_DB: measured.database };
    const cookie = `${secure ? "__Secure-" : ""}${user.cookie}`;

    const sessions = [];
    for (let i = 0; i < 3; i++)
      sessions.push(
        await createAuth(authEnv).api.getSession({ headers: new Headers({ Cookie: cookie }) }),
      );

    expect(sessions.map((session) => session?.user.id)).toEqual([user.id, user.id, user.id]);
    expect(measured.schemaQueries()).toEqual([]);
  });

  test(`${protocol}: 全migrationのスキーマを明示的な検証で確認する`, async () => {
    const options = createAuth(bindings(secure)).options;
    const auth = betterAuth({
      ...options,
      advanced: { ...options.advanced, database: { validateSchema: true } },
    });

    const session = await auth.api.getSession({ headers: new Headers() });

    expect(session).toBeNull();
  });

  for (const missing of ["table", "column"] as const)
    test(`${protocol}: スキーマ検証は不足する${missing}を検出する`, async () => {
      const options = createAuth(bindings(secure)).options;
      const auth = betterAuth({
        ...options,
        advanced: { ...options.advanced, database: { validateSchema: true } },
        user: {
          ...options.user,
          ...(missing === "table"
            ? { modelName: "auth_schema_missing_user" }
            : {
                additionalFields: {
                  ...options.user?.additionalFields,
                  authSchemaMissingColumn: { type: "string" as const, required: false },
                },
              }),
        },
      });

      await expect(auth.api.getSession({ headers: new Headers() })).rejects.toThrow(
        missing === "table" ? "auth_schema_missing_user" : "authSchemaMissingColumn",
      );
    });

  test(`${protocol}: 有効な登録者とゲストのCookieが併存する場合は登録者を使う`, async () => {
    const authEnv = bindings(secure);
    const user = await accountFixture();
    const anonymous = await guest(authEnv);
    const request = new Request(authEnv.APP_ORIGIN, {
      headers: {
        Cookie: `${anonymous.cookie}; ${secure ? "__Secure-" : ""}${user.cookie}`,
      },
    });

    const identity = await accountIdentity(request, authEnv);

    expect(identity?.id).toBe(user.id);
  });
}

for (const cookie of [
  undefined,
  "tetraboard-2026.analytics=visitor",
  `tetraboard-2026.guest=${"a".repeat(64)}`,
])
  // 修正前はCookieがあるだけで構造確認SQLを発行し、DBアクセスのアサーションで失敗します。
  test(`${cookie?.split("=")[0] ?? "Cookieなし"}: 登録者セッション確認はDBを使わない`, async () => {
    const measured = observeDatabase(env.APP_DB);
    const request = new Request(origin, { headers: cookie ? { Cookie: cookie } : {} });

    const identity = await accountSessionIdentity(request, { ...env, APP_DB: measured.database });

    expect(identity).toBeNull();
    expect(measured.queries).toEqual([]);
  });

test("ゲストCookieだけでも有効なゲストを認証し、構造確認SQLを発行しない", async () => {
  const anonymous = await guest(env);
  const measured = observeDatabase(env.APP_DB);
  const request = new Request(origin, { headers: { Cookie: anonymous.cookie } });

  const identity = await accountIdentity(request, { ...env, APP_DB: measured.database });

  expect(identity?.id).toBe(anonymous.id);
  expect(measured.schemaQueries()).toEqual([]);
});

for (const kind of ["empty", "tampered", "expired"] as const)
  test(`${kind}: 登録者セッションが無効でも併存するゲストへ復帰しない`, async () => {
    const user = await accountFixture();
    const anonymous = await guest(env);
    if (kind === "expired")
      await env.APP_DB.prepare("UPDATE session SET expiresAt = ? WHERE token = ?")
        .bind(Date.now() - 1, user.token)
        .run();
    const registeredCookie =
      kind === "empty"
        ? "tetraboard-2026.session_token="
        : kind === "tampered"
          ? `${user.cookie}bad`
          : user.cookie;
    const request = new Request(origin, {
      headers: { Cookie: `${anonymous.cookie}; ${registeredCookie}` },
    });

    const identity = await accountIdentity(request, env);

    expect(identity).toBeNull();
  });
