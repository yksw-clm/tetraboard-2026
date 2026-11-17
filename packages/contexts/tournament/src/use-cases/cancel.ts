import type { TournamentQueueRuntime } from "./ports";
import type { State } from "../domain/queue";
import { ok, fail, tokenKey, controllerCancelKey, holder } from "../domain/queue";
import type { Result } from "../domain/queue";
import { rollback } from "./rollback";
import { forget } from "./waiting";
export async function cancel(
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
  if (!currentHolder) {
    // 待機POSTより先に届く取消は、その操作元の初期世代だけを失効させます。
    if (controllerId && controllerVersion !== undefined)
      r.storage.cancel(controllerCancelKey(operationId, controllerId, controllerVersion));
    return ok;
  }
  r.storage.cancel(tokenKey(accountId, operationId));
  const wait = state.waiting.find(
    (w) => w.accountId === accountId && w.operationId === operationId,
  );
  if (wait) {
    await forget(r, wait);
    state.waiting = state.waiting.filter((w) => w !== wait);
    r.storage.save(state);
  }
  const group = state.groups.find((g) =>
    g.players.some((p) => p.accountId === accountId && p.operationId === operationId),
  );
  if (group && group.phase !== "playing") await rollback(r, state, group, [accountId]);
  return ok;
}
