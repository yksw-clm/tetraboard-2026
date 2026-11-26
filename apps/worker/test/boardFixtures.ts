import { env } from "cloudflare:workers";
import {
  boardAdminSchema,
  boardDetailSchema,
  boardTimelineSchema,
} from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { expect } from "vitest";
import worker from "../src/worker";
import { origin } from "./accountFixtures";

export const boardPath = "/games/reversi/posts";
export const postPath = (id: string) => `/posts/${id}`;
export const repliesPath = (id: string) => `${postPath(id)}/replies`;
export const likePath = (id: string) => `${postPath(id)}/like`;

export function reportPost(
  id: string,
  headers?: HeadersInit,
  input: unknown = { reason: "abuse" },
) {
  return boardRequest(`${postPath(id)}/reports`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
}

export function boardAdminRequest(adminId: string, init?: RequestInit) {
  return boardRequest("/admin/board", init, {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify([adminId]),
  });
}

export async function boardAdminPage(admin: { id: string; headers: HeadersInit }) {
  const response = await boardAdminRequest(admin.id, { headers: admin.headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return boardAdminSchema.parse(await response.json());
}

export function boardRequest(
  path: string,
  init?: RequestInit,
  bindings: Env = env,
  prefix = "/api",
) {
  return worker.fetch(new Request(origin + prefix + path, init), bindings, {} as ExecutionContext);
}

export function sendBoardPost(
  path: string,
  text: string,
  headers?: HeadersInit,
  requestId = crypto.randomUUID(),
) {
  return boardRequest(path, { method: "POST", headers, body: JSON.stringify({ requestId, text }) });
}

export async function timeline(suffix = "", cookie?: string) {
  const response = await boardRequest(boardPath + suffix, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return boardTimelineSchema.parse(await response.json());
}

export async function detail(id: string, cookie?: string) {
  const response = await boardRequest(postPath(id), { headers: cookie ? { Cookie: cookie } : {} });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return boardDetailSchema.parse(await response.json());
}

export async function resetBoard() {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM board_reports"),
    env.APP_DB.prepare("DELETE FROM board_likes"),
    env.APP_DB.prepare("DELETE FROM board_posts"),
    env.APP_DB.prepare("DELETE FROM board_senders"),
    env.APP_DB.prepare("UPDATE board_settings SET accepting=0"),
  ]);
}

export async function openBoard() {
  await env.APP_DB.prepare("UPDATE board_settings SET accepting=1 WHERE id=1").run();
}

export function boardPostFixture({
  accountId,
  id = crypto.randomUUID(),
  parentId = null,
  gameId = "reversi",
  postedAtMs = Date.now(),
  text = "掲示板の本文",
}: {
  accountId: string;
  id?: string;
  parentId?: string | null;
  gameId?: GameId;
  postedAtMs?: number;
  text?: string;
}) {
  return {
    id,
    postedAtMs,
    text,
    statement: env.APP_DB.prepare(
      "INSERT INTO board_posts(id,game_id,parent_id,account_id,body,posted_at_ms,request_id,body_hash) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(id, gameId, parentId, accountId, text, postedAtMs, crypto.randomUUID(), "fixture"),
  };
}
