import type { GuardRow } from "./lethalGuard";

export type GuardBudgetPolicy = "fixed-50" | "incumbent" | "reserve" | "progress";

/** 同じ全体期限の中で、一問へ渡す上限だけを決めます。未完成候補を再試行して時間を追加しません。 */
export function allocateGuardQuery(
  policy: GuardBudgetPolicy,
  total: number,
  remaining: number,
  previous: readonly GuardRow[],
  targetsLeft: number,
): number {
  let allocation = Math.max(10, total / 2);
  if (policy === "incumbent") allocation = previous.length ? remaining : total * 0.7;
  else if (policy === "reserve") allocation = previous.length ? remaining : total * 0.4;
  else if (policy === "progress") {
    if (!previous.length) allocation = total * 0.4;
    else if (previous[0].status === "unsafe" && !previous.some((r) => r.status === "safe"))
      allocation = remaining;
    else {
      const last = previous.at(-1)!,
        proof = last.proof;
      const nodes = proof ? Object.values(proof.nodes) : [];
      const branches =
        nodes.reduce((sum, n) => sum + n.legal.length, 0) /
        Math.max(1, nodes.filter((n) => n.legal.length).length);
      // 時間切れかつ分岐が広い検査に残り全量を費やさず、後続にも一問分を残します。
      allocation =
        proof?.limit === "time" && branches > 16
          ? Math.min(total * 0.35, remaining / 2)
          : remaining / Math.max(1, targetsLeft);
    }
  }
  return Math.max(0, Math.min(remaining, Math.max(1, allocation)));
}
