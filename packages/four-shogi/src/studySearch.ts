import { getAnalysisLegalActions, type AnalysisPosition } from "./analysis";
import { compareAiValue, evaluateAiPosition } from "./aiEvaluation";
import { resolveAiOptions } from "./ai";
import { createAiContext, makeAiCandidate, type AiBranch, type AiContext } from "./aiSearchContext";
import { getCheckState, pieces, attacksSquare } from "./board";
import { pieceValue } from "./cpuEvaluation";
import type { OrdinaryMove } from "./moves";
import { getActiveSides, handPieceKinds, sides, type FourShogiState, type Side } from "./types";
import type {
  AiAlternativeRisk,
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchStats,
} from "./aiTypes";

export const studySearchVersion = "local-root-maxn-v4";
export const studyEvaluationVersion = "local-sole-first-pressure-v1";
export type StudyProfile = "study" | "baseline";
export type StudyEngagement = { attacker: Side; target: Side; pressure: number };
export type StudyMaterialEvidence = {
  initialAssets: number;
  lineDelta: number;
  lossWitness: readonly AiLineStep[] | null;
  complete: boolean;
  limit: "work_limit" | "ply_limit" | "interrupted" | null;
};
export type StudyCandidate = AiCandidate & {
  rootIndex: number;
  study: {
    immediateLoss: readonly AiLineStep[] | null;
    immediateRepliesComplete: boolean;
    rightSide: Side | null;
    rightCheckPriority: boolean;
    magic: boolean;
    magicEvidence: {
      status: "candidate" | "line_confirmed";
      target: Side;
      returnedAtPly: number | null;
    } | null;
    material: StudyMaterialEvidence;
    engagements: readonly StudyEngagement[];
    explanations: readonly string[];
  };
};
export type StudyLaneSnapshot = {
  lane: number;
  depth: number;
  done: boolean;
  candidates: StudyCandidate[];
  staticEvaluation: AiEvaluation;
  stats: AiSearchStats;
};
export type StudyRootOptions = {
  lane?: number;
  lanes?: number;
  maxDepth?: number;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  cacheSize?: number;
  dangerWork?: number;
  profile?: StudyProfile;
};

/** 画面回転や脱落によって、元の右隣を別の相手へ付け替えません。 */
export function studyRightSide(state: FourShogiState, side: Side): Side | null {
  const right = sides[(sides.indexOf(side) + sides.length - 1) % sides.length];
  return getActiveSides(state).includes(right) ? right : null;
}

function assets(state: FourShogiState, side: Side): number {
  if (!getActiveSides(state).includes(side)) return 0;
  return (
    pieces(state.board).reduce(
      (sum, entry) => sum + (entry.piece.side === side ? pieceValue(entry.piece) : 0),
      0,
    ) +
    handPieceKinds.reduce(
      (sum, kind) =>
        sum + state.hands[side][kind] * pieceValue({ id: -1, side, kind, promoted: false }),
      0,
    )
  );
}

function engagements(state: FourShogiState): StudyEngagement[] {
  const active = getActiveSides(state);
  const all = pieces(state.board).filter(({ piece }) => active.includes(piece.side));
  const pressure = Object.fromEntries(
    sides.map((a) => [a, Object.fromEntries(sides.map((b) => [b, 0]))]),
  ) as Record<Side, Record<Side, number>>;
  for (const target of all) {
    for (const attacker of all) {
      if (attacker.piece.side === target.piece.side || attacker.piece.kind === "king") continue;
      if (attacksSquare(state.board, attacker.piece, attacker.position, target.position)) {
        pressure[attacker.piece.side][target.piece.side] +=
          target.piece.kind === "king" ? 400 : Math.min(200, pieceValue(target.piece) * 0.2);
      }
    }
  }
  return active.flatMap((attacker) =>
    active
      .filter((target) => target !== attacker && pressure[attacker][target] > 0)
      .map((target) => ({ attacker, target, pressure: pressure[attacker][target] })),
  );
}

/** 利きによる圧力は戦略上の目安で、三人攻撃の合法性や相手の選択を断定しません。 */
function studyEvaluation(state: FourShogiState): AiEvaluation {
  const base = evaluateAiPosition(state);
  if (state.status === "finished") return base;
  const active = getActiveSides(state);
  const all = pieces(state.board).filter(({ piece }) => active.includes(piece.side));
  const relations = engagements(state);
  const pressure = (a: Side, b: Side) =>
    relations.find((entry) => entry.attacker === a && entry.target === b)?.pressure ?? 0;
  const checked = getCheckState(state);
  const values = { ...base.values };
  for (const side of active) {
    const opponents = active.filter((other) => other !== side);
    let engagement = 0;
    for (let a = 0; a < opponents.length; a++)
      for (let b = a + 1; b < opponents.length; b++) {
        const mutual = Math.min(
          pressure(opponents[a], opponents[b]),
          pressure(opponents[b], opponents[a]),
        );
        const ownExposure = Math.max(pressure(opponents[a], side), pressure(opponents[b], side));
        // 自王へ圧力が向く場合、第三者同士の争いによる余裕を見込みません。
        engagement += Math.max(0, mutual - ownExposure) * 0.06;
      }
    const forcedAway = active.some((other) => other !== side && checked[other]);
    let skippedDefense = 0;
    if (state.turn !== side && forcedAway) {
      for (const target of all.filter(
        ({ piece }) => piece.side === side && piece.kind !== "king",
      )) {
        const threats = all.filter(
          ({ piece, position }) =>
            piece.side !== side && attacksSquare(state.board, piece, position, target.position),
        );
        if (threats.length && !checked[side]) skippedDefense += pieceValue(target.piece) * 0.12;
      }
    }
    const score = base.values[side].heuristicScore! + Math.min(150, engagement) - skippedDefense;
    values[side] = {
      ...values[side],
      heuristicScore: score,
      primary: Math.max(
        Number.EPSILON,
        Math.min(1 - Number.EPSILON, 0.5 + Math.atan(score / 10000) / Math.PI),
      ),
    };
  }
  for (const side of active)
    values[side] = {
      ...values[side],
      secondaryRank:
        1 + active.filter((other) => values[other].primary > values[side].primary).length,
    };
  return {
    ...base,
    values,
    ranks: base.ranks.map((entry) =>
      entry.kind === "confirmed" ? entry : { ...entry, rank: values[entry.side].secondaryRank },
    ),
  };
}

function lineAssets(state: FourShogiState, side: Side, line: readonly AiLineStep[]): number {
  let total = assets(state, side);
  const board = state.board.map((row) => [...row]);
  for (const step of line) {
    if (step.captured?.side === side) total -= pieceValue(step.captured);
    if (step.captured && step.side === side)
      total += pieceValue({ ...step.captured, promoted: false });
    const action = step.action;
    if (action.type === "movePiece") {
      const piece = board[action.from.y][action.from.x];
      if (piece) {
        const moved = { ...piece, promoted: piece.promoted || action.promote };
        if (piece.side === side) total += pieceValue(moved) - pieceValue(piece);
        board[action.to.y][action.to.x] = moved;
        board[action.from.y][action.from.x] = null;
      }
    } else
      board[action.to.y][action.to.x] = {
        id: -1,
        side: step.side,
        kind: action.pieceKind,
        promoted: false,
      };
    if (step.eliminations.some((entry) => entry.side === side)) return 0;
  }
  return total;
}

function probeMaterialReplies(
  ctx: AiContext,
  input: FourShogiState,
  first: AiLineStep,
  quota: number,
  initialAssets: number,
) {
  const result: AiAlternativeRisk = {
    kind: "possible_legal_replies",
    complete: false,
    limit: "interrupted",
    work: 0,
    nodes: 0,
    eliminationWitness: null,
    rookLossWitness: null,
  };
  const material: Pick<StudyMaterialEvidence, "lossWitness" | "complete" | "limit"> = {
    lossWitness: null,
    complete: false,
    limit: "interrupted",
  };
  const started = { work: ctx.stats.work, nodes: ctx.stats.nodes };
  let horizon = false;
  function* visit(state: FourShogiState, line: AiLineStep[]): Generator<number, void> {
    yield* ctx.spend(0);
    if (!getActiveSides(state).includes(ctx.root!)) {
      result.eliminationWitness ??= line;
      return;
    }
    if (assets(state, ctx.root!) < initialAssets) material.lossWitness ??= line;
    if (state.status === "finished" || state.turn === ctx.root) return;
    if (line.length >= ctx.settings.dangerPlies) {
      horizon = true;
      return;
    }
    const replies = yield* ctx.moves(state);
    const ordered = replies
      .map((move, index) => ({
        move,
        index,
        score: move.captured?.side === ctx.root ? pieceValue(move.captured) : 0,
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    // 取り返せる人へ仮の手番を渡さず、各着手の正本が返す実手番をたどります。
    for (const { move } of ordered) {
      const next = yield* ctx.advance(state, move, line.length);
      const path = [...line, next.step];
      if (next.step.captured?.side === ctx.root && next.step.captured.kind === "rook")
        result.rookLossWitness ??= path;
      yield* visit(next.state, path);
    }
  }
  function* run(): Generator<number, void> {
    const steps = visit(input, [first]);
    try {
      for (let next = steps.next(); !next.done; next = steps.next()) {
        if (ctx.stats.work - started.work + next.value > quota) {
          result.limit = material.limit = "work_limit";
          return;
        }
        yield next.value;
      }
      result.complete = material.complete = !horizon;
      result.limit = material.limit = horizon ? "ply_limit" : null;
    } finally {
      steps.return();
      result.work = ctx.stats.work - started.work;
      result.nodes = ctx.stats.nodes - started.nodes;
    }
  }
  return { result, material, steps: run() };
}

export function evaluateStudyPosition(position: AnalysisPosition): AiEvaluation {
  getAnalysisLegalActions(position); // Enforce the trusted-position boundary, including setups.
  return studyEvaluation(position.state);
}

function rightCheckBonus(state: FourShogiState, move: OrdinaryMove): number {
  const right = studyRightSide(state, state.turn!);
  return right && !getCheckState(state)[right] && getCheckState(move.state)[right] ? 180 : 0;
}
export function compareStudyCandidates(a: StudyCandidate, b: StudyCandidate, root: Side): number {
  const terminalWin = (entry: StudyCandidate) =>
    Number(
      entry.evaluation?.evaluationKind === "terminal" &&
        entry.evaluation.values[root].primary === 1,
    );
  return (
    terminalWin(b) - terminalWin(a) ||
    Number(a.study.immediateLoss !== null) - Number(b.study.immediateLoss !== null) ||
    (a.evaluation && b.evaluation
      ? compareAiValue(b.evaluation.values[root], a.evaluation.values[root])
      : 0) ||
    (a.evaluation && b.evaluation
      ? Number(b.study.rightCheckPriority) - Number(a.study.rightCheckPriority)
      : 0) ||
    a.rootIndex - b.rootIndex
  );
}
export function selectStudyRootIndices(
  candidates: readonly StudyCandidate[],
  root: Side,
  width = 24,
): number[] {
  return [...candidates]
    .sort((a, b) => compareStudyCandidates(a, b, root))
    .filter(
      (candidate, index) =>
        index < width ||
        candidate.line[0]?.captured !== null ||
        (candidate.line[0]?.checkedSides.length ?? 0) > 0,
    )
    .map((candidate) => candidate.rootIndex);
}

/** 各プロセスは同じ完全状態から探索し、全候補の完成深さを呼出側でそろえます。 */
export function createStudyRootSearch(position: AnalysisPosition, options: StudyRootOptions = {}) {
  getAnalysisLegalActions(position);
  const lane = options.lane ?? 0;
  const lanes = options.lanes ?? 1;
  if (
    !Number.isSafeInteger(lanes) ||
    lanes < 1 ||
    lanes > 32 ||
    !Number.isSafeInteger(lane) ||
    lane < 0 ||
    lane >= lanes
  )
    throw new TypeError("探索レーンが不正です");
  const settings = resolveAiOptions({
    codeVersion: studySearchVersion,
    maxWork: Number.MAX_SAFE_INTEGER,
    maxDepth: options.maxDepth ?? 256,
    width: options.width ?? 6,
    rootWidth: options.rootWidth ?? 24,
    extensions: options.extensions ?? 2,
    cacheSize: options.cacheSize ?? 1024,
    candidateCount: 5,
    dangerWork: 0,
  }).settings;
  const profile = options.profile ?? "study";
  const ctx = createAiContext(
    position.state,
    settings,
    undefined,
    profile === "study" ? { evaluate: studyEvaluation, orderingBonus: rightCheckBonus } : undefined,
  );
  const { stats, root } = ctx;
  const initialAssets = root ? assets(position.state, root) : 0;
  const rootEngagements = engagements(position.state);
  type Entry = {
    index: number;
    rightCheckPriority: boolean;
    move: OrdinaryMove;
    state: FourShogiState;
    branch: AiBranch;
    nodes: number;
    work: number;
  };
  const roots: Entry[] = [];
  const risks = new Map<number, NonNullable<AiCandidate["danger"]["alternatives"]>>();
  const materialProofs = new Map<
    number,
    Pick<StudyMaterialEvidence, "lossWitness" | "complete" | "limit">
  >();
  const immediate = new Map<number, { loss: readonly AiLineStep[] | null; complete: boolean }>();
  let published: Entry[] = [];
  let depth = 0;
  let done = false;
  let selected: Set<number> | null = null;
  let materialRootIndices: Set<number> | null = null;
  function make(entry: Entry): StudyCandidate {
    const candidate = makeAiCandidate(
      entry.move.action,
      entry.branch,
      root!,
      depth,
      entry.nodes,
      entry.work,
    );
    const first = candidate.line[0];
    const right = root ? studyRightSide(position.state, root) : null;
    const magic = Boolean(
      right &&
      first?.captured &&
      first.captured.side !== right &&
      first.checkedSides.includes(right),
    );
    const returnStep =
      candidate.danger.untilNextOwnTurn === "returned" ? candidate.danger.evidence.at(-1) : null;
    const lineDelta = root ? lineAssets(position.state, root, candidate.line) - initialAssets : 0;
    const confirmed = Boolean(
      magic &&
      first?.nextTurn === right &&
      returnStep &&
      returnStep.afterPly > 1 &&
      lineAssets(position.state, root!, candidate.danger.evidence) > initialAssets,
    );
    const magicEvidence: StudyCandidate["study"]["magicEvidence"] = magic
      ? {
          status: confirmed ? "line_confirmed" : "candidate",
          target: right!,
          returnedAtPly: confirmed ? returnStep!.afterPly : null,
        }
      : null;
    const proof = immediate.get(entry.index);
    const material = {
      initialAssets,
      lineDelta,
      ...(materialProofs.get(entry.index) ?? {
        lossWitness: null,
        complete: false,
        limit: "interrupted" as const,
      }),
    };
    return {
      ...candidate,
      selective: depth > 1 || candidate.selective,
      rootIndex: entry.index,
      danger: { ...candidate.danger, alternatives: risks.get(entry.index) ?? null },
      study: {
        immediateLoss: proof?.loss ?? null,
        immediateRepliesComplete: proof?.complete ?? false,
        rightSide: right,
        rightCheckPriority: entry.rightCheckPriority,
        magic,
        magicEvidence,
        material,
        engagements: rootEngagements,
        explanations: [
          ...(magic
            ? [
                confirmed
                  ? "この読み筋では右王への王手で先に自手番へ戻り、資産増加を保っています。全応手に対する成立証明ではありません。"
                  : "右王への王手を伴う第三者の駒取りの候補です。自手番への復帰と損得は未確認です。",
              ]
            : []),
          ...(proof?.loss ? ["次の相手手番で自分が脱落する合法手があります。"] : []),
          ...(material.lossWitness ? ["次の実自手番までに資産が減る合法な応手列があります。"] : []),
        ],
      },
    };
  }
  function* explore(
    state: FourShogiState,
    remaining: number,
    extra: number,
    ply: number,
  ): Generator<number, AiBranch> {
    yield* ctx.spend(0);
    if (state.status === "finished" || !getActiveSides(state).includes(root!))
      return { evaluation: yield* ctx.evaluate(state), line: [], selective: false };
    const checked = getCheckState(state)[state.turn];
    if (
      remaining <= 0 &&
      extra > 0 &&
      (checked || state.lastMove?.captured || state.turn === root)
    ) {
      remaining = 1;
      extra--;
      stats.extendedNodes++;
    }
    if (remaining <= 0)
      return { evaluation: yield* ctx.evaluate(state), line: [], selective: false };
    const legal = yield* ctx.moves(state);
    const moves = yield* ctx.ordered(state, legal);
    let best: AiBranch | null = null;
    let bestIndex = Infinity;
    for (const { move, index } of moves) {
      const next = yield* ctx.advance(state, move, ply);
      const child = yield* explore(next.state, remaining - 1, extra, ply + 1);
      const comparison = best
        ? compareAiValue(child.evaluation.values[state.turn], best.evaluation.values[state.turn])
        : 1;
      if (comparison > 0 || (comparison === 0 && index < bestIndex)) {
        best = {
          ...child,
          line: [next.step, ...child.line],
          selective: moves.length < legal.length || child.selective,
        };
        bestIndex = index;
      }
    }
    return best ?? { evaluation: yield* ctx.evaluate(state), line: [], selective: false };
  }
  function* inspectImmediate(entry: Entry): Generator<number, void> {
    const proof = { loss: null as readonly AiLineStep[] | null, complete: false };
    immediate.set(entry.index, proof);
    let exhausted = true;
    if (!getActiveSides(entry.state).includes(root!)) proof.loss = entry.branch.line;
    else if (entry.state.status === "playing" && entry.state.turn !== root) {
      const responses = yield* ctx.moves(entry.state);
      for (const move of responses) {
        const next = yield* ctx.advance(entry.state, move, 1);
        if (!getActiveSides(next.state).includes(root!)) {
          proof.loss = [entry.branch.line[0], next.step];
          exhausted = false;
          break;
        }
      }
    }
    proof.complete = exhausted;
  }
  function* inspectMaterial(entry: Entry): Generator<number, void> {
    const probe = probeMaterialReplies(
      ctx,
      entry.state,
      entry.branch.line[0],
      options.dangerWork ?? 128,
      initialAssets,
    );
    risks.set(entry.index, probe.result);
    materialProofs.set(entry.index, probe.material);
    yield* probe.steps;
  }
  function* run(): Generator<number, void> {
    if (position.state.status === "finished" || !ctx.legal.length) return;
    // 元の番号でレーンを固定したまま、各レーン内では右への新規王手を先に調べます。
    const orderedRoots = ctx.legal
      .map((move, index) => ({
        move,
        index,
        rightCheckPriority: profile === "study" && rightCheckBonus(position.state, move) > 0,
      }))
      .sort(
        (a, b) => Number(b.rightCheckPriority) - Number(a.rightCheckPriority) || a.index - b.index,
      );
    for (const { index, move, rightCheckPriority } of orderedRoots) {
      if (index % lanes !== lane) continue;
      const before = { ...stats };
      const next = yield* ctx.advance(ctx.start, move, 0);
      const evaluation = yield* ctx.evaluate(next.state);
      roots.push({
        index,
        rightCheckPriority,
        move,
        state: next.state,
        branch: { evaluation, line: [next.step], selective: false },
        nodes: stats.nodes - before.nodes,
        work: stats.work - before.work,
      });
    }
    published = roots;
    depth = stats.completedDepth = 1;
    // この境界で全プロセスに共通する根候補集合を受け取ります。
    yield* ctx.spend(0);
    const active = roots.filter((entry) => selected === null || selected.has(entry.index));
    // 浅い全体評価の先頭5件を固定し、後の反復で順位が変わっても検査範囲を偽りません。
    const materialIndices =
      profile !== "study"
        ? new Set<number>()
        : (materialRootIndices ??
          new Set(
            lanes === 1
              ? selectStudyRootIndices(roots.map(make), root!, settings.rootWidth).slice(0, 5)
              : [],
          ));
    if (profile === "study") for (const entry of active) yield* inspectImmediate(entry);
    for (let nextDepth = 2; nextDepth <= settings.maxDepth; nextDepth++) {
      const completed: Entry[] = [];
      for (const entry of active) {
        const before = { ...stats };
        const branch = yield* explore(entry.state, nextDepth - 1, settings.extensions, 1);
        completed.push({
          ...entry,
          branch: { ...branch, line: [entry.branch.line[0], ...branch.line] },
          nodes: stats.nodes - before.nodes,
          work: stats.work - before.work,
        });
      }
      published = completed;
      depth = stats.completedDepth = nextDepth;
      yield* ctx.spend(0);
      // 深さ2の完成結果を全レーンで公開してから、表示用の詳細検査へ残り予算を使います。
      if (profile === "study" && nextDepth === 2)
        for (const entry of completed)
          if (materialIndices.has(entry.index)) yield* inspectMaterial(entry);
    }
  }
  const steps = run();
  return {
    get depth() {
      return depth;
    },
    step() {
      if (done) return true;
      const next = steps.next();
      done = next.done ?? false;
      return done;
    },
    setRootIndices(indices: readonly number[]) {
      selected = new Set(indices);
      materialRootIndices = new Set(indices.slice(0, 5));
    },
    snapshot(): StudyLaneSnapshot {
      return {
        lane,
        depth,
        done,
        candidates: published.map(make),
        staticEvaluation: ctx.staticEvaluation,
        stats: { ...stats },
      };
    },
    dispose() {
      steps.return();
      done = true;
    },
  };
}
