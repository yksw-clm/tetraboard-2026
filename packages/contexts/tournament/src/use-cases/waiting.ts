import type { TournamentQueueRuntime } from "./ports";
import type { Waiting } from "../domain/queue";
import { tokenKey, locallyValid } from "../domain/queue";
export function validWait(r: TournamentQueueRuntime, wait: Waiting) {
  return locallyValid(
    wait,
    r.now(),
    r.storage.cancelled(tokenKey(wait.accountId, wait.operationId)),
  );
}
export async function leaseValid(r: TournamentQueueRuntime, wait: Waiting, key: string) {
  if (!validWait(r, wait)) return false;
  return r.store.leaseValid(wait, key);
}
export async function forget(r: TournamentQueueRuntime, wait: Waiting) {
  r.storage.cancel(tokenKey(wait.accountId, wait.operationId));
  await r.store.forget(wait);
}
