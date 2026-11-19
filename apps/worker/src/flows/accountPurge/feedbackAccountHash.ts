import type { AuthEnv } from "../../adapters/account/auth";

export async function feedbackAccountHash(env: AuthEnv, id: string) {
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
