// loaderとReactの取得処理で、同じタブの認証更新を照合します。
let generation = 0;
export const accountRequestGeneration = () => generation;
export const advanceAccountRequestGeneration = () => ++generation;
export const isCurrentAccountRequest = (expected: number, signal?: AbortSignal) =>
  expected === generation && !signal?.aborted;

export type AccountRecoveryResult = {
  status: "authenticated" | "signed-out" | "unavailable" | "stale";
  generation: number;
};
export class StaleAccountRequestError extends Error {}

export function unauthorizedAccountResponse(expected: number) {
  return Response.json({ accountRequestGeneration: expected }, { status: 401 });
}
