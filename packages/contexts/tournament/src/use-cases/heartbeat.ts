import type { TournamentQueueRuntime } from "./ports";
import type { State } from "../domain/queue";
import { ok, fail, holder, tokenKey } from "../domain/queue";
import type { Result } from "../domain/queue";
import { stage } from "../domain/stage";
import { participation } from "./status";
import { validWait } from "./waiting";

const waitingEnded = fail("待機は終了しました。状態を再確認してください。");

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
    for (const group of state.groups) {
      if (group.phase !== "confirming" && group.phase !== "preparing") continue;
      const player = group.players.find((p) => p === currentHolder);
      if (!player) continue;
      if (r.storage.cancelled(tokenKey(accountId, operationId))) return waitingEnded;
      const row = await r.read(state.key);
      if (!row || !(await r.eligible(accountId, state.key))) return waitingEnded;
      const now = r.now();
      if (stage(row, now) !== "active" || group.expiresAtMs <= now) return waitingEnded;
      player.waitingExpiresAtMs = now + r.rules.leaseMs;
      r.storage.save(state);
      return ok;
    }
    const current = await participation(r, state, accountId, controllerId);
    return currentHolder &&
      current.operationId === operationId &&
      ["matched", "playing"].includes(current.status)
      ? ok
      : waitingEnded;
  }
  if (!validWait(r, wait)) return waitingEnded;
  const expiresAtMs = r.now() + r.rules.leaseMs;
  const updated = await r.store.heartbeat(wait, expiresAtMs);
  if (!updated) return fail("待機は終了しました。");
  wait.expiresAtMs = expiresAtMs;
  r.storage.save(state);
  return ok;
}
