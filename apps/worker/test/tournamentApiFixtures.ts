import { legacyTournamentSettings, getTournamentSettings } from "@tetraboard/protocol";
import { env } from "cloudflare:workers";
import { beforeEach, expect } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  tournamentRecordSchema,
  type TournamentInput,
  type TournamentRecord,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import type { AdminEnv } from "../src/admin/auth";
import { accountFixture, origin } from "./accountFixtures";

const context = { waitUntil: () => {} } as unknown as ExecutionContext;

export const fetchWith = (path: string, init?: RequestInit, bindings: AdminEnv = env) =>
  worker.fetch(new Request(origin + path, init), bindings as Env, context);

export const input = (overrides: Partial<TournamentInput> = {}): TournamentInput => ({
  settings: legacyTournamentSettings,
  name: "第一回 四人将棋大会",
  description: "初参加も歓迎します。\r\n途中参加できます。",
  rulesDescription: "気軽に参加してください。",
  startsAtMs: Date.now() + 3600000,
  endsAtMs: Date.now() + 7200000,
  ...overrides,
});

export async function admin() {
  const user = await accountFixture();
  return { user, bindings: { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([user.id]) } };
}

type Admin = Awaited<ReturnType<typeof admin>>;

export const adminFetch = (a: Admin, path: string, method = "GET", body?: unknown) =>
  fetchWith(
    path,
    {
      method,
      headers: a.user.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    a.bindings,
  );

export async function create(a: Admin, value = input()) {
  const response = await adminFetch(a, "/api/admin/tournaments", "POST", value);
  expect(response.status).toBe(201);
  return tournamentRecordSchema.parse(await response.json());
}

export async function publish(a: Admin, record: TournamentRecord) {
  const response = await adminFetch(a, `/api/admin/tournaments/${record.key}/publish`, "POST", {
    version: record.version,
  });
  expect(response.status).toBe(200);
  return tournamentRecordSchema.parse(await response.json());
}

export async function read(a: Admin, key: string) {
  const response = await adminFetch(a, `/api/admin/tournaments/${key}`);
  expect(response.status).toBe(200);
  return tournamentRecordSchema.parse(await response.json());
}

export const entry = (id: number, headers: Record<string, string>) =>
  fetchWith(`/api/tournaments/${id}/entries`, {
    method: "POST",
    headers: { ...headers, "X-Legal-Consent": legalVersion },
  });

export const editInput = (record: TournamentRecord): TournamentInput => ({
  settings: getTournamentSettings(record),
  name: record.name,
  description: record.description,
  rulesDescription: record.rulesDescription,
  startsAtMs: record.startsAtMs,
  endsAtMs: record.endsAtMs,
});

export function useTournamentApiFixtures() {
  beforeEach(async () => {
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM tournament_point_events"),
      env.APP_DB.prepare("DELETE FROM tournament_scores"),
      env.APP_DB.prepare("DELETE FROM tournament_match_players"),
      env.APP_DB.prepare("DELETE FROM tournament_matches"),
      env.APP_DB.prepare("DELETE FROM tournament_wait_reservations"),
      env.APP_DB.prepare("DELETE FROM tournament_entries"),
      env.APP_DB.prepare("DELETE FROM tournaments"),
    ]);
  });
}
