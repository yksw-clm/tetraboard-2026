import type { TournamentQueueRuntime } from "./ports";
import type { State } from "../domain/queue";
import { ok, fail, holder } from "../domain/queue";
import type { Result } from "../domain/queue";
import { participation } from "./status";
import { validWait } from "./waiting";
export async function heartbeat(
  r: TournamentQueueRuntime,
  state: State,
  accountId: string,
  operationId: string,
  controllerId?: string,
  controllerVersion?: number,
): Promise<Result> {
  const currentHolder = holder(state, accountId, operationId);
  if (
    currentHolder &&
    (currentHolder.controllerId !== controllerId ||
      currentHolder.controllerVersion !== controllerVersion)
  )
    return fail("操作元が別のタブに移りました。");
  const wait = state.waiting.find(
    (w) => w.accountId === accountId && w.operationId === operationId,
  );
  if (!wait) {
    const current = await participation(r, state, accountId, controllerId);
    return currentHolder &&
      current.operationId === operationId &&
      ["matched", "playing"].includes(current.status)
      ? ok
      : fail("待機は終了しました。状態を再確認してください。");
  }
  if (!validWait(r, wait)) return fail("待機は終了しました。状態を再確認してください。");
  const expiresAtMs = r.now() + r.rules.leaseMs;
  const updated = await r.store.heartbeat(wait, expiresAtMs);
  if (!updated) return fail("待機は終了しました。");
  wait.expiresAtMs = expiresAtMs;
  r.storage.save(state);
  return ok;
}
