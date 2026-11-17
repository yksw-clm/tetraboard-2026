import type { Wait } from "@tetraboard/context-matchmaking";
import { matchmakingRules as rules } from "@tetraboard/protocol";
import { authSecret } from "../../privacy/tokens";
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export async function matchmakingCredential(env: Env, wait: Wait, queueKey: string = rules.key) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = JSON.stringify([
    "tetraboard:matchmaking-membership:v1",
    queueKey,
    wait.accountId,
    wait.operationId,
    wait.controllerId,
    wait.version,
  ]);
  const token = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return {
    token,
    tokenHash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  };
}
