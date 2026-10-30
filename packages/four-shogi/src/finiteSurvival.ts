import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "./analysis";
import { getActiveSides, type FourShogiAction, type Side } from "./types";
import { encodeAction, decodeAction } from "./actionEncoding";
import {
  requireFiniteCache,
  readFiniteCache,
  rememberFiniteNode,
  type FiniteProofCache,
  type FiniteCacheStats,
} from "./finiteProofCache";
export { createFiniteProofCache } from "./finiteProofCache";

export type FiniteStatus = "safe" | "unsafe" | "unknown";
export type SafetyMetrics = {
  visits: number;
  legalCalls: number;
  legalActions: number;
  localHits: number;
  legalMs: number;
  transitionMs: number;
  orderingMs: number;
  certificateMs: number;
  traversalMs: number;
};
export type SafetyNode = {
  hash: string;
  remaining: number;
  turn: Side | null;
  status: FiniteStatus;
  reason: "leaf" | "searched" | "budget";
  legal: number[];
  edges: { action: number; child: string }[];
};
export type SafetyProof = {
  inputHash: string;
  root: Side;
  action: FourShogiAction;
  horizon: number;
  status: FiniteStatus;
  goal: "survival-for-finite-real-plies";
  opponentModel: "all-opponents-adversarial";
  transitions: number;
  elapsedMs: number;
  entry: string | null;
  nodes: Record<string, SafetyNode>;
  work?: number;
  estimatedBytes?: number;
  limit?: string | null;
  metrics?: SafetyMetrics;
  cacheStats?: FiniteCacheStats;
};
export type SafetyBudget = {
  maxTransitions: number;
  maxMs: number;
  preferred?: Record<string, number[]>;
  maxWork?: number;
  maxNodes?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  measureStages?: boolean;
  cache?: FiniteProofCache;
  order?: (
    position: AnalysisPosition,
    actions: readonly FourShogiAction[],
  ) => readonly FourShogiAction[];
};

/** 生存だけの有限検証です。相手側は全合法手、本人の将来手は存在量化し、勝利や無限の安全を証明しません。 */
export async function proveFiniteAction(
  position: AnalysisPosition,
  action: FourShogiAction,
  root: Side,
  horizon: number,
  budget: SafetyBudget,
): Promise<SafetyProof> {
  if (position.state.turn !== root || !Number.isSafeInteger(horizon) || horizon < 1 || horizon > 4)
    throw new Error("有限検証の手番または手数が不正です");
  if (
    !Number.isSafeInteger(budget.maxTransitions) ||
    budget.maxTransitions < 0 ||
    !(budget.maxMs >= 0)
  )
    throw new Error("有限検証の予算が不正です");
  const chosen = getAnalysisLegalActions(position).find(
    (move) => encodeAction(move) === encodeAction(action),
  );
  for (const value of [budget.maxWork, budget.maxNodes, budget.maxBytes])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("有限検証の追加上限が不正です");
  if (!chosen) throw new Error("非合法な代替着手です");
  if (budget.cache) requireFiniteCache(budget.cache, position, root);
  const started = performance.now(),
    deadline = started + budget.maxMs;
  const nodes: Record<string, SafetyNode> = {};
  const metrics: SafetyMetrics = {
    visits: 0,
    legalCalls: 0,
    legalActions: 0,
    localHits: 0,
    legalMs: 0,
    transitionMs: 0,
    orderingMs: 0,
    certificateMs: 0,
    traversalMs: 0,
  };
  const clock = () => (budget.measureStages ? performance.now() : 0);
  const advance = async (current: AnalysisPosition, side: Side, move: FourShogiAction) => {
    const before = clock();
    const next = await advanceAnalysisPosition(current, { type: "action", side, action: move });
    metrics.transitionMs += clock() - before;
    return next;
  };
  let transitions = 0,
    work = 0,
    estimatedBytes = 0,
    nodeCount = 0,
    limit: string | null = null;
  const available = () => {
    limit = budget.signal?.aborted
      ? "cancelled"
      : performance.now() >= deadline
        ? "time"
        : transitions >= budget.maxTransitions
          ? "transitions"
          : work >= (budget.maxWork ?? Infinity)
            ? "work"
            : nodeCount >= (budget.maxNodes ?? Infinity)
              ? "nodes"
              : estimatedBytes >= (budget.maxBytes ?? Infinity)
                ? "memory"
                : null;
    return limit === null;
  };
  const visit = async (current: AnalysisPosition, remaining: number): Promise<string> => {
    metrics.visits++;
    const key = `${current.stateHash}/${remaining}`;
    if (nodes[key]?.status !== undefined && nodes[key].status !== "unknown") {
      metrics.localHits++;
      return key;
    }
    if (budget.cache && available()) {
      const hit = readFiniteCache(budget.cache, key, {
        nodes: (budget.maxNodes ?? Infinity) - nodeCount,
        bytes: (budget.maxBytes ?? Infinity) - estimatedBytes,
        work: (budget.maxWork ?? Infinity) - work,
        available,
      });
      if (hit) {
        Object.assign(nodes, hit.nodes);
        nodeCount += Object.keys(hit.nodes).length;
        estimatedBytes += hit.bytes;
        work += Object.keys(hit.nodes).length;
        return key;
      }
    }
    const certificateStarted = clock();
    const alive = getActiveSides(current.state).includes(root);
    const node: SafetyNode = {
      hash: current.stateHash,
      remaining,
      turn: current.state.turn,
      status: "unknown",
      reason: "budget",
      legal: [],
      edges: [],
    };
    nodes[key] = node;
    nodeCount++;
    estimatedBytes += 384;
    metrics.certificateMs += clock() - certificateStarted;
    if (!alive || current.state.status === "finished" || remaining === 0) {
      node.status = alive ? "safe" : "unsafe";
      node.reason = "leaf";
      if (budget.cache && !budget.signal?.aborted)
        rememberFiniteNode(budget.cache, key, node, nodes);
      return key;
    }
    if (!available()) return key;
    const legalStarted = clock();
    const legal = getAnalysisLegalActions(current);
    metrics.legalCalls++;
    metrics.legalActions += legal.length;
    metrics.legalMs += clock() - legalStarted;
    work += legal.length;
    estimatedBytes += legal.length * 24;
    if (!legal.length) throw new Error("正本の未解決な合法手なし局面です");
    const orderStarted = clock();
    node.legal = legal.map(encodeAction).sort((a, b) => a - b);
    const preferred = budget.preferred?.[current.stateHash] ?? [];
    const ordered = budget.order
      ? budget.order(current, legal)
      : [...legal].sort((a, b) => {
          const ai = preferred.indexOf(encodeAction(a)),
            bi = preferred.indexOf(encodeAction(b));
          return (
            (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || encodeAction(a) - encodeAction(b)
          );
        });
    if (
      budget.order &&
      JSON.stringify(ordered.map(encodeAction).sort((a, b) => a - b)) !== JSON.stringify(node.legal)
    )
      throw new Error("応手の順序付けは全合法手を一度ずつ保持する必要があります");
    metrics.orderingMs += clock() - orderStarted;
    const own = current.state.turn === root;
    for (const move of ordered) {
      if (!available()) break;
      transitions++;
      work++;
      const next = await advance(current, current.state.turn!, move);
      const child = await visit(next, remaining - 1);
      const edgeStarted = clock();
      node.edges.push({ action: encodeAction(move), child });
      metrics.certificateMs += clock() - edgeStarted;
      if ((own && nodes[child].status === "safe") || (!own && nodes[child].status === "unsafe")) {
        node.status = nodes[child].status;
        node.reason = "searched";
        if (budget.cache && !budget.signal?.aborted)
          rememberFiniteNode(budget.cache, key, node, nodes);
        return key;
      }
    }
    if (
      node.edges.length === legal.length &&
      node.edges.every((edge) => nodes[edge.child].status === (own ? "unsafe" : "safe"))
    ) {
      node.status = own ? "unsafe" : "safe";
      node.reason = "searched";
      if (budget.cache && !budget.signal?.aborted)
        rememberFiniteNode(budget.cache, key, node, nodes);
    }
    return key;
  };
  let entry: string | null = null;
  if (available()) {
    transitions++;
    work++;
    entry = await visit(await advance(position, root, chosen), horizon - 1);
  }
  const elapsedMs = performance.now() - started;
  metrics.traversalMs = Math.max(
    0,
    elapsedMs - metrics.legalMs - metrics.transitionMs - metrics.orderingMs - metrics.certificateMs,
  );
  return {
    inputHash: position.stateHash,
    root,
    action: chosen,
    horizon,
    status: entry ? nodes[entry].status : "unknown",
    goal: "survival-for-finite-real-plies",
    opponentModel: "all-opponents-adversarial",
    transitions,
    elapsedMs,
    entry,
    nodes,
    work,
    estimatedBytes,
    limit,
    metrics: budget.measureStages ? metrics : undefined,
    cacheStats: budget.cache?.stats,
  };
}

/** 保存された証明辺を正本で再生成し、全称節点で合法手の欠落を拒否します。 */
export async function validateFiniteProof(position: AnalysisPosition, proof: SafetyProof) {
  if (
    !Number.isSafeInteger(proof.horizon) ||
    proof.horizon < 1 ||
    proof.horizon > 4 ||
    proof.goal !== "survival-for-finite-real-plies" ||
    proof.opponentModel !== "all-opponents-adversarial"
  )
    throw new Error("証明の有限範囲・量化条件が不正です");
  if (position.stateHash !== proof.inputHash || position.state.turn !== proof.root)
    throw new Error("証明の入力が一致しません");
  if (proof.status === "unknown") return { verified: false, reason: "incomplete", checkedNodes: 0 };
  const action = getAnalysisLegalActions(position).find(
    (move) => encodeAction(move) === encodeAction(proof.action),
  );
  if (!action || !proof.entry) throw new Error("証明の初手が不正です");
  const checked = new Set<string>();
  const validate = async (
    current: AnalysisPosition,
    remaining: number,
    key: string,
  ): Promise<FiniteStatus> => {
    const node = proof.nodes[key];
    if (
      !node ||
      key !== `${current.stateHash}/${remaining}` ||
      node.hash !== current.stateHash ||
      node.remaining !== remaining ||
      node.turn !== current.state.turn
    )
      throw new Error("証明節点のhash・深さ・手番が不正です");
    if (checked.has(key)) return node.status;
    const alive = getActiveSides(current.state).includes(proof.root);
    if (!alive || current.state.status === "finished" || remaining === 0) {
      if (node.reason !== "leaf" || node.status !== (alive ? "safe" : "unsafe"))
        throw new Error("有限地平の終端が不正です");
      checked.add(key);
      return node.status;
    }
    if (node.reason !== "searched" || node.status === "unknown")
      throw new Error("未完成の証明節点です");
    const legal = getAnalysisLegalActions(current),
      ids = legal.map(encodeAction).sort((a, b) => a - b);
    if (JSON.stringify(node.legal) !== JSON.stringify(ids))
      throw new Error("全合法手の集合が一致しません");
    if (new Set(node.edges.map((edge) => edge.action)).size !== node.edges.length)
      throw new Error("証明辺が重複しています");
    const own = current.state.turn === proof.root;
    const universal = (own && node.status === "unsafe") || (!own && node.status === "safe");
    if (
      universal &&
      JSON.stringify(node.edges.map((edge) => edge.action).sort((a, b) => a - b)) !==
        JSON.stringify(ids)
    )
      throw new Error("全称節点の合法応手が欠落しています");
    const relevant = universal
      ? node.edges
      : node.edges.filter((edge) => proof.nodes[edge.child]?.status === node.status).slice(0, 1);
    if (!relevant.length) throw new Error("証拠となる応手がありません");
    for (const edge of relevant) {
      const move = legal.find((candidate) => encodeAction(candidate) === edge.action);
      if (!move) throw new Error("非合法な証明辺です");
      const value = await validate(
        await advanceAnalysisPosition(current, {
          type: "action",
          side: current.state.turn!,
          action: move,
        }),
        remaining - 1,
        edge.child,
      );
      if (value !== node.status) throw new Error("証明の量化条件が成立しません");
    }
    checked.add(key);
    return node.status;
  };
  const status = await validate(
    await advanceAnalysisPosition(position, { type: "action", side: proof.root, action }),
    proof.horizon - 1,
    proof.entry,
  );
  if (status !== proof.status) throw new Error("証明結果が一致しません");
  return { verified: true, reason: "canonical-certificate-replay", checkedNodes: checked.size };
}

/** 部分探索中の脱落葉から合法な一本道を返します。本人の全回避手を調べた証明とは区別します。 */
export function finiteLossWitness(proof: SafetyProof): FourShogiAction[] | null {
  if (!proof.entry) return null;
  const seen = new Set<string>();
  const visit = (key: string): FourShogiAction[] | null => {
    if (seen.has(key)) return null;
    seen.add(key);
    const node = proof.nodes[key];
    if (!node) return null;
    if (node.reason === "leaf" && node.status === "unsafe") return [];
    for (const edge of node.edges) {
      const suffix = visit(edge.child);
      if (suffix) return [decodeAction(edge.action), ...suffix];
    }
    return null;
  };
  const suffix = visit(proof.entry);
  return suffix ? [proof.action, ...suffix] : null;
}
