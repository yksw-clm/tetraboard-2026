import { sides, type FourShogiAction, type Side } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import type { AiCandidate } from "@tetraboard/four-shogi/ai";

export type FocusReuseIdentity = Readonly<{ scope: string; side: Side; conditions: string }>;
type Hint = { action: FourShogiAction; fromDepth: number; at: number };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 完成PVの合法な着手順序だけを保持します。評価や完成探索結果には使いません。 */
export function createFocusHints(
  options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
) {
  const capacity = options.maxEntries ?? 256,
    ttl = options.ttlMs ?? 30000,
    now = options.now ?? (() => performance.now());
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 0 ||
    capacity > 1024 ||
    !Number.isFinite(ttl) ||
    ttl < 0
  )
    throw Error("PV保持枠が不正です");
  const entries = new Map<string, Hint>();
  let generation = 0;
  let hits = 0,
    rejected = 0;
  const key = (p: AnalysisPosition, id: FocusReuseIdentity) =>
    JSON.stringify([
      id.scope,
      id.side,
      id.conditions,
      p.stateHash,
      sides.map((s) => p.state.players[s]),
    ]);
  const prune = () => {
    for (const [k, v] of entries) if (now() - v.at > ttl) entries.delete(k);
  };
  return {
    async offer(p: AnalysisPosition, id: FocusReuseIdentity, candidates: readonly AiCandidate[]) {
      const token = generation;
      getAnalysisLegalActions(p);
      if (!id.scope || p.state.turn !== id.side) {
        rejected++;
        return;
      }
      const pending = new Map<string, Hint>();
      for (const candidate of candidates.slice(0, 4)) {
        if (candidate.completedDepth < 1 || candidate.cutoff || !candidate.line.length) {
          rejected++;
          continue;
        }
        let current = p;
        const path: [string, Hint][] = [];
        try {
          for (const [i, step] of candidate.line.slice(0, 64).entries()) {
            if (
              step.side !== current.state.turn ||
              step.afterPly !== i + 1 ||
              !getAnalysisLegalActions(current).some((a) => same(a, step.action))
            )
              throw Error("PVと実手番が不一致です");
            const next = await advanceAnalysisPosition(current, {
              type: "action",
              side: step.side,
              action: step.action,
            });
            if (token !== generation) return;
            if (next.state.turn !== step.nextTurn) throw Error("PVの次手番が不一致です");
            path.push([
              key(current, id),
              {
                action: structuredClone(step.action),
                fromDepth: candidate.completedDepth,
                at: now(),
              },
            ]);
            current = next;
          }
          for (const [k, v] of path) if (!pending.has(k)) pending.set(k, v);
        } catch {
          rejected++;
        }
      }
      if (token !== generation) return;
      prune();
      for (const [k, v] of pending) {
        entries.delete(k);
        entries.set(k, v);
      }
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
    },
    get(
      p: AnalysisPosition,
      id: FocusReuseIdentity,
    ): { action: FourShogiAction; fromDepth: number } | null {
      const legal = getAnalysisLegalActions(p);
      prune();
      const v = entries.get(key(p, id));
      if (!v || !legal.some((a) => same(a, v.action))) return null;
      hits++;
      return { action: structuredClone(v.action), fromDepth: v.fromDepth };
    },
    clear() {
      generation++;
      entries.clear();
    },
    stats() {
      prune();
      return {
        entries: entries.size,
        hits,
        rejected,
        bytes: [...entries].reduce((n, [k, v]) => n + 2 * (k.length + JSON.stringify(v).length), 0),
      };
    },
  };
}
/** 選別済みの根集合と同順位規則は保ち、担当への投入順だけを変えます。 */
export function prioritizeFocusRoots<T extends { rootIndex: number; action: FourShogiAction }>(
  queue: readonly number[],
  candidates: readonly T[],
  hint: FourShogiAction | null,
): number[] {
  const index = hint ? candidates.find((c) => same(c.action, hint))?.rootIndex : undefined;
  return index !== undefined && queue.includes(index)
    ? [index, ...queue.filter((i) => i !== index)]
    : [...queue];
}
