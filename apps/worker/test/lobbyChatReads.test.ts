import { env } from "cloudflare:workers";
import { expect, onTestFinished, test } from "vitest";
import worker from "../src/worker";
import { analyticsCookie } from "../src/usageEvents/browserId";
import { accountFixture, origin } from "./accountFixtures";

function observeChatReads(failure?: "batch" | "database") {
  const batches: number[] = [];
  const reads: string[] = [];
  function observeStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => observeStatement(target.bind(...values), sql);
        const value = Reflect.get(target, key);
        if (
          ["first", "all", "raw"].includes(String(key)) &&
          /\b(?:lobby_chat_\w+|tournaments)\b/i.test(sql)
        )
          return (...args: unknown[]) => {
            reads.push(sql);
            if (failure === "database") throw new Error("D1 unavailable");
            return value.apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => observeStatement(target.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          if (failure) throw new Error("D1 batch failed");
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, batches, reads };
}

async function createTournament(id: number, published: boolean) {
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), id, "公開チャット", 10000, 20000, Number(published), 0, 0)
    .run();
  onTestFinished(async () => {
    await env.APP_DB.prepare("DELETE FROM tournaments WHERE public_id=?").bind(id).run();
  });
}

function readChat(path: string, db: D1Database, cookie?: string) {
  return worker.fetch(
    new Request(origin + "/api" + path, { headers: cookie ? { Cookie: cookie } : {} }),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
}

test.each([
  { path: "/lobby/chat", tournament: false, statements: 2 },
  { path: "/tournaments/74144/chat", tournament: true, statements: 3 },
])("$path の未ログイン閲覧は1回のbatchで取得する", async ({ path, tournament, statements }) => {
  if (tournament) await createTournament(74144, true);
  const { db, batches, reads } = observeChatReads();

  const response = await readChat(path, db);

  expect(response.status).toBe(200);
  expect(batches).toEqual([statements]);
  expect(reads).toEqual([]);
});

test("解析Cookieだけの大会チャットは1回のbatchで取得し、Cookieを発行しない", async () => {
  await createTournament(74148, true);
  const { db, batches, reads } = observeChatReads();
  const cookie = `${analyticsCookie}=2cf4188c-fd30-4fdb-9d1e-ad388a21782f`;

  const response = await readChat("/tournaments/74148/chat", db, cookie);

  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(batches).toEqual([3]);
  expect(reads).toEqual([]);
});

test("本人の大会チャットは公開確認のあとにチャットの4項目をまとめて取得する", async () => {
  await createTournament(74145, true);
  const user = await accountFixture();
  const { db, batches, reads } = observeChatReads();

  const response = await readChat("/tournaments/74145/chat", db, user.cookie);

  expect(response.status).toBe(200);
  expect(batches).toEqual([4]);
  expect(reads).toHaveLength(1);
});

test("非公開大会のGETではゲストセッションを更新せず404を返す", async () => {
  await createTournament(74146, false);
  const { db, batches, reads } = observeChatReads();
  const cookie = `tetraboard-2026.guest=${"a".repeat(64)}`;

  const response = await readChat("/tournaments/74146/chat", db, cookie);

  expect(response.status).toBe(404);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(batches).toEqual([]);
  expect(reads).toHaveLength(1);
});

test.each([
  {
    failure: "batch" as const,
    message: "チャットを処理できませんでした。もう一度お試しください。",
  },
  {
    failure: "database" as const,
    message: "処理できませんでした。時間をおいて再試行してください。",
  },
])("公開大会のGETでは $failure 障害に対応する503応答を返す", async ({ failure, message }) => {
  await createTournament(74147, true);
  const { db } = observeChatReads(failure);

  const response = await readChat("/tournaments/74147/chat", db);

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ message });
});
