import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, expect, onTestFinished, vi } from "vitest";
import { tournamentChatSchema } from "@tetraboard/protocol/general-lobby";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";

export async function publishedChatTournament(db: D1Database, id: number) {
  const key = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
      VALUES(?,?,'大会チャット検証',?,?,1,?,?)`)
    .bind(key, id, now + 3600000, now + 7200000, now, now)
    .run();
  onTestFinished(async () => {
    await db.batch([
      db.prepare("DELETE FROM lobby_chat_reports WHERE tournament_id=?").bind(id),
      db.prepare("DELETE FROM lobby_chat_requests WHERE tournament_id=?").bind(id),
      db.prepare("DELETE FROM lobby_chat_messages WHERE tournament_id=?").bind(id),
      db.prepare("DELETE FROM tournament_entries WHERE tournament_key=?").bind(key),
      db.prepare("DELETE FROM tournaments WHERE key=?").bind(key),
    ]);
  });
  return {
    path: `/tournaments/${id}/chat`,
    async enroll(accountId: string) {
      await db
        .prepare(
          "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
        )
        .bind(crypto.randomUUID(), key, accountId, now)
        .run();
    },
  };
}

const db = (env as typeof env & { LOBBY_TEST_DB: D1Database }).LOBBY_TEST_DB;
export function useTournamentChatFixtures() {
  beforeAll(async () => {
    await applyD1Migrations(
      db,
      (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
        .TEST_MIGRATIONS,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.batch(
      [
        "lobby_chat_reports",
        "lobby_chat_messages",
        "lobby_chat_requests",
        "lobby_chat_senders",
        "tournament_entries",
        "tournaments",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    );
    await db.prepare("UPDATE lobby_chat_settings SET accepting=1").run();
  });
  return { db, request, user, tournament, enroll, path, post, read, moderate };
}

const request = (path: string, init?: RequestInit, owner?: string) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, init),
    { ...env, APP_DB: db, ADMIN_ACCOUNT_IDS: owner ? JSON.stringify([owner]) : "[]" },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
const user = () => accountFixture(true, crypto.randomUUID(), db);
type User = Pick<Awaited<ReturnType<typeof user>>, "id" | "headers">;
async function tournament(id = 1, finalized: number | null = null, published = true) {
  const key = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      key,
      id,
      `大会${id}`,
      Date.now() + 3600000,
      Date.now() + 7200000,
      Number(published),
      finalized,
      Date.now(),
      Date.now(),
    )
    .run();
  return { id, key };
}
async function enroll(t: Awaited<ReturnType<typeof tournament>>, u: User) {
  await db
    .prepare(
      "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
    )
    .bind(crypto.randomUUID(), t.key, u.id, Date.now())
    .run();
}
const path = (id: number) => `/tournaments/${id}/chat`;
const post = (
  id: number,
  u: User,
  text = "よろしくお願いします",
  requestId = crypto.randomUUID(),
) =>
  request(path(id), {
    method: "POST",
    headers: u.headers,
    body: JSON.stringify({ text, requestId }),
  });
async function read(id: number, u?: User, suffix = "") {
  const response = await request(path(id) + suffix, u ? { headers: u.headers } : undefined);
  expect(response.status).toBe(200);
  return tournamentChatSchema.parse(await response.json());
}
const moderate = (u: User, body: unknown) =>
  request(
    "/admin/lobby-chat",
    { method: "POST", headers: u.headers, body: JSON.stringify(body) },
    u.id,
  );
