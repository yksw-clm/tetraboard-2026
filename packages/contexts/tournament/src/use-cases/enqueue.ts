import type { TournamentQueueRuntime } from "./ports";
import type { State, Waiting } from "../domain/queue";
import { ok, fail, tokenKey, controllerCancelKey, holder } from "../domain/queue";
import { stage } from "../domain/stage";
import type { Result } from "../domain/queue";
import { participation } from "./status";
import { tick } from "./tick";
export async function enqueue(
  r: TournamentQueueRuntime,
  state: State,
  accountId: string,
  operationId: string,
  tokenHash: string,
  controllerId?: string,
): Promise<Result> {
  const row = await r.read(state.key);
  if (!row || stage(row, r.now()) !== "active")
    return fail("現在は大会の対局を受け付けていません。");
  if (!(await r.eligible(accountId, state.key)))
    return fail("先に大会へエントリーしてください。", 403);
  if (
    r.storage.cancelled(tokenKey(accountId, operationId)) ||
    (controllerId && r.storage.cancelled(controllerCancelKey(operationId, controllerId, 1)))
  )
    return fail("この待機は取り消されています。もう一度操作してください。");
  const existing = await participation(r, state, accountId);
  if (existing.status === "idle" && holder(state, accountId, operationId))
    return fail("この待機は終了しています。もう一度操作してください。");
  if (existing.status !== "idle")
    return existing.operationId === operationId &&
      holder(state, accountId, operationId)?.controllerId === controllerId
      ? ok
      : fail("別の操作元で対局または待機中です。");
  const wait: Waiting = {
    accountId,
    operationId,
    tokenHash,
    expiresAtMs: r.now() + r.rules.leaseMs,
    ...(controllerId ? { controllerId, controllerVersion: 1 } : {}),
  };
  try {
    await r.store.enqueue(wait, state.key);
  } catch {
    return fail("別のルームや大会で対局または待機中です。退出してから再試行してください。");
  }
  state.waiting.push(wait);
  r.storage.save(state);
  await tick(r, state);
  return ok;
}
