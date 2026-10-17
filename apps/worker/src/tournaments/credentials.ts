import { authSecret } from "../privacy/tokens";

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function tournamentCredential(
  env: Env,
  input: {
    accountId: string;
    tournamentKey: string;
    operationId: string;
    controllerId: string;
    controllerVersion: number;
  },
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = JSON.stringify([
    "tetraboard:tournament-membership:v1",
    input.accountId,
    input.tournamentKey,
    input.operationId,
    input.controllerId,
    input.controllerVersion,
  ]);
  const token = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const tokenHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return { token, tokenHash };
}
