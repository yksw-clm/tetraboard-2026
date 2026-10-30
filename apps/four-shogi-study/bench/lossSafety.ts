import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, type FourShogiAction, type Side } from "@tetraboard/four-shogi";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";

export type FiniteStatus = "safe" | "unsafe" | "unknown";
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
};
export type SafetyBudget = {
  maxTransitions: number;
  maxMs: number;
  preferred?: Record<string, number[]>;
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
  if (!chosen) throw new Error("非合法な代替着手です");
  const started = performance.now(),
    deadline = started + budget.maxMs;
  const nodes: Record<string, SafetyNode> = {};
  let transitions = 0;
  const available = () => transitions < budget.maxTransitions && performance.now() < deadline;
  const visit = async (current: AnalysisPosition, remaining: number): Promise<string> => {
    const key = `${current.stateHash}/${remaining}`;
    if (nodes[key]?.status !== undefined && nodes[key].status !== "unknown") return key;
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
    if (!alive || current.state.status === "finished" || remaining === 0) {
      node.status = alive ? "safe" : "unsafe";
      node.reason = "leaf";
      return key;
    }
    if (!available()) return key;
    const legal = getAnalysisLegalActions(current);
    if (!legal.length) throw new Error("正本の未解決な合法手なし局面です");
    node.legal = legal.map(encodeAction).sort((a, b) => a - b);
    const preferred = budget.preferred?.[current.stateHash] ?? [];
    const ordered = [...legal].sort((a, b) => {
      const ai = preferred.indexOf(encodeAction(a)),
        bi = preferred.indexOf(encodeAction(b));
      return (
        (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || encodeAction(a) - encodeAction(b)
      );
    });
    const own = current.state.turn === root;
    for (const move of ordered) {
      if (!available()) break;
      transitions++;
      const next = await advanceAnalysisPosition(current, {
        type: "action",
        side: current.state.turn!,
        action: move,
      });
      const child = await visit(next, remaining - 1);
      node.edges.push({ action: encodeAction(move), child });
      if ((own && nodes[child].status === "safe") || (!own && nodes[child].status === "unsafe")) {
        node.status = nodes[child].status;
        node.reason = "searched";
        return key;
      }
    }
    if (
      node.edges.length === legal.length &&
      node.edges.every((edge) => nodes[edge.child].status === (own ? "unsafe" : "safe"))
    ) {
      node.status = own ? "unsafe" : "safe";
      node.reason = "searched";
    }
    return key;
  };
  let entry: string | null = null;
  if (available()) {
    transitions++;
    entry = await visit(
      await advanceAnalysisPosition(position, { type: "action", side: root, action: chosen }),
      horizon - 1,
    );
  }
  return {
    inputHash: position.stateHash,
    root,
    action: chosen,
    horizon,
    status: entry ? nodes[entry].status : "unknown",
    goal: "survival-for-finite-real-plies",
    opponentModel: "all-opponents-adversarial",
    transitions,
    elapsedMs: performance.now() - started,
    entry,
    nodes,
  };
}

/** 保存された証明辺を正本で再生成し、全称節点で合法手の欠落を拒否します。 */
export async function validateFiniteProof(position: AnalysisPosition, proof: SafetyProof) {
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
