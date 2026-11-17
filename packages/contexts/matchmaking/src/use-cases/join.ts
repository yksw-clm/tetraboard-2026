import type { MatchmakingRuntime } from "./ports";
import { type State, type Wait } from "../domain/state";

import { tick } from "./tick";
import { snapshot } from "./status";
export async function join(
  r: MatchmakingRuntime,
  state: State,
  accountId: string,
  operationId: string,
  controllerId: string,
) {
  await tick(r, state);
  const current = await snapshot(r, state, accountId, controllerId);
  if (current.status !== "idle")
    return current.operationId === operationId && current.controllerId === controllerId
      ? { ok: true as const, state: current }
      : { ok: false as const, message: "別のタブやルームで対局または待機中です。" };
  if (r.retired) return { ok: false as const, message: "旧ランダムマッチの受付は終了しました。" };
  // 終了済みの同じ操作を遅延再送しても、新しい待機を作りません。
  const profile = await r.store.profile(accountId, Boolean(r.ratingPolicy));
  if (r.storage.ended(operationId) || !profile)
    return {
      ok: false as const,
      message: "この待機は終了しています。もう一度操作してください。",
    };
  state.nextSequence = (state.nextSequence ?? 0) + 1;
  const wait: Wait = {
    sequence: state.nextSequence,
    accountId,
    operationId,
    controllerId,
    version: 1,
    joinedAtMs: r.now(),
    isTest: Boolean(profile.isTest),
    expiresAtMs: r.now() + r.queueRules.leaseMs,
  };
  const failure = await reserveWait(r, state, wait);
  if (failure) return failure;
  if (r.game === "four-shogi" && r.diagnostics) wait.diagnosticId = r.randomId();
  state.waiting.push(wait);
  r.event(wait, "accepted", null);
  r.storage.save(state);
  if (wait.diagnosticId)
    r.diagnostic("four_shogi_queue_accepted", {
      diagnosticId: wait.diagnosticId,
      atMs: r.now(),
    });
  await tick(r, state);
  return { ok: true as const, state: await snapshot(r, state, accountId, controllerId) };
}

async function reserveWait(r: MatchmakingRuntime, state: State, wait: Wait) {
  const policy = r.ratingPolicy;
  try {
    const result = await r.store.join(
      wait,
      state.key,
      !r.legacy && r.game === "four-reversi" ? r.legacyKey : "",
      Boolean(policy),
    );
    if (!result.inserted)
      return {
        ok: false as const,
        message: "前局のレート結果を保存中です。少し待ってから再試行してください。",
      };
    if (policy) {
      const latest = result.latest;
      wait.rating = latest?.rating_after ?? policy.initialRating;
      if (policy.initialSigma !== undefined) {
        wait.sigma = latest?.sigma_after ?? policy.initialSigma;
        wait.ratedGames = latest?.rated_games ?? 0;
      }
    }
  } catch {
    return {
      ok: false as const,
      message: "別のルームや大会で対局または待機中です。退出してから再試行してください。",
    };
  }
}
