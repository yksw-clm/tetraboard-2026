import type { MatchmakingRuntime } from "./ports";
import { type State } from "../domain/state";

import { tick } from "./tick";
import { snapshot } from "./status";
import { locate } from "../domain/waits";
import { forget, rollback, recoverCredentials } from "./rollback";
export async function control(
  r: MatchmakingRuntime,
  state: State,
  accountId: string,
  input: { operationId: string; controllerId: string; version: number },
  action: "heartbeat" | "cancel",
) {
  await tick(r, state);
  const { wait, group } = locate(state, accountId);
  if (
    !wait ||
    wait.operationId !== input.operationId ||
    wait.controllerId !== input.controllerId ||
    wait.version !== input.version
  )
    return { ok: false as const, message: "待機の操作元が変わったか、有効期限が切れました。" };
  if (action === "cancel") {
    if ((r.ratingPolicy || r.retired) && (group?.phase === "matched" || group?.phase === "playing"))
      return {
        ok: true as const,
        state: await snapshot(r, state, accountId, input.controllerId),
      };
    if (group?.phase === "playing")
      return {
        ok: false as const,
        message: "対局が開始されています。対局画面へ戻ってください。",
      };
    r.storage.end(wait.operationId);
    if (group) await rollback(r, state, group, [accountId], 0, "cancelled");
    else {
      await forget(r, wait, state, "cancelled");
      state.waiting = state.waiting.filter((w) => w.operationId !== wait.operationId);
    }
  } else if (!group) {
    wait.expiresAtMs = r.now() + r.queueRules.leaseMs;
    await r.store.heartbeat(wait);
  }
  return {
    ok: true as const,
    state: await snapshot(r, state, accountId, input.controllerId),
  };
}

export async function takeover(
  r: MatchmakingRuntime,
  state: State,
  accountId: string,
  operationId: string,
  controllerId: string,
  expectedVersion: number,
) {
  await tick(r, state);
  await snapshot(r, state, accountId, controllerId);
  const { wait, group } = locate(state, accountId);
  if (!wait || wait.operationId !== operationId)
    return { ok: false as const, message: "この待機は終了しています。" };
  if (
    wait.version !== expectedVersion &&
    !(wait.controllerId === controllerId && wait.version === expectedVersion + 1)
  )
    return {
      ok: false as const,
      message: "操作元が変わりました。状態を確認してから引き継いでください。",
    };
  if (wait.controllerId !== controllerId) {
    wait.controllerId = controllerId;
    wait.version++;
    if (group) group.players.find((p) => p.accountId === accountId)!.credentialPending = true;
    r.storage.save(state);
    if (group) {
      const player = group.players.find((p) => p.accountId === accountId)!;
      await recoverCredentials(r, state, group);
      if (player.credentialPending) throw Error("操作元を復旧しています");
    }
  }
  return { ok: true as const, state: await snapshot(r, state, accountId, controllerId) };
}
