import { bytesToHex, hexToBytes } from "./tokenCrypto";
import { viewerSecretKey } from "./storageKeys";
import type { RoomRuntime } from "./runtime";

export async function viewerMac(runtime: RoomRuntime, nonce: string): Promise<string> {
  const secret = runtime.ctx.storage.kv.get<string>(viewerSecretKey);
  if (secret === undefined) throw new Error("Missing viewer secret");
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce)),
  );
  return bytesToHex(mac.slice(0, 16));
}

export async function issueViewerToken(runtime: RoomRuntime): Promise<string | null> {
  await runtime.reconcileDeadlines();
  if (runtime.readRoom() === null) return null;
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const prefix = bytesToHex(nonce);
  return prefix + (await viewerMac(runtime, prefix));
}
