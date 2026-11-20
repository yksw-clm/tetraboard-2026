import { env } from "cloudflare:workers";
import worker from "../src/worker";
import type { FeedbackEnv } from "../src/routes/feedbackRoutes";
import { accountFixture, origin } from "./accountFixtures";

const context = { waitUntil: () => {} } as unknown as ExecutionContext;

export const fetchWith = (path: string, init?: RequestInit, bindings: FeedbackEnv = env) =>
  worker.fetch(new Request(origin + path, init), bindings, context);

export const input = (overrides = {}) => ({
  submissionId: crypto.randomUUID(),
  kind: "bug",
  game: "four-reversi",
  body: "画面の表示が崩れました",
  expectation: "石数を読める",
  steps: "スマホを横にする",
  technical: null,
  ...overrides,
});

export function webp(width = 256, height = 256) {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 24, true);
  view.setUint32(16, 12, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

export function form(data: unknown, image?: Uint8Array) {
  const body = new FormData();
  body.set("input", JSON.stringify(data));
  if (image) body.set("attachment", new File([image], "capture.webp", { type: "image/webp" }));
  return body;
}

export const post = (
  data: unknown = input(),
  cookie = "",
  image?: Uint8Array,
  bindings: FeedbackEnv = env,
  ip = "192.0.2.1",
) =>
  fetchWith(
    "/api/feedback",
    {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "CF-Connecting-IP": ip },
      body: form(data, image),
    },
    bindings,
  );

export async function admin() {
  const user = await accountFixture();
  return { user, bindings: { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([user.id]) } };
}

export const getAdmin = (path: string, a: Awaited<ReturnType<typeof admin>>) =>
  fetchWith(`/api/admin/feedback${path}`, { headers: { Cookie: a.user.cookie } }, a.bindings);

export async function resetFeedback() {
  await env.APP_DB.batch(
    ["feedback_history", "feedback", "feedback_topics", "feedback_limits", "feedback_uploads"].map(
      (t) => env.APP_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
