import { matchmakingStateSchema } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountRequest } from "../account/accountApi";
export { matchmakingPath } from "./paths";
const api = "/api/matchmaking/four-reversi";
export async function readMatchmaking(controllerId: string, signal?: AbortSignal) {
  return matchmakingStateSchema.parse(
    await accountRequest(`${api}?controllerId=${encodeURIComponent(controllerId)}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    }),
  );
}
export async function matchmakingOperation(
  action: "join" | "heartbeat" | "cancel" | "takeover",
  input: { operationId: string; controllerId: string; version?: number },
  signal?: AbortSignal,
) {
  return matchmakingStateSchema.parse(
    await accountRequest(`${api}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Legal-Consent": legalVersion },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    }),
  );
}
