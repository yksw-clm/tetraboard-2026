import { getCheckState, sides, type Side } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  validateAnalysisReplayEvent,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import type { AiCandidate, AiEvaluation, AiLineStep } from "@tetraboard/four-shogi/ai";
import type { StudyRecordedAnalysis } from "../shared/model";

function fail(): never {
  throw new Error("保存された解析結果の形式または局面が一致しません");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) fail();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) fail();
  return value;
}
function evaluation(value: unknown): AiEvaluation {
  const raw = object(value);
  if (
    !["heuristic", "terminal", "sample_mean", "model"].includes(String(raw.evaluationKind)) ||
    raw.probabilities !== null
  )
    fail();
  const entries = object(raw.values);
  const values = Object.fromEntries(
    sides.map((side) => {
      const entry = object(entries[side]);
      const score = entry.heuristicScore;
      if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) fail();
      return [
        side,
        {
          primary: number(entry.primary, 1),
          secondaryRank: number(entry.secondaryRank, 4),
          heuristicScore: score,
        },
      ];
    }),
  ) as AiEvaluation["values"];
  if (!Array.isArray(raw.ranks) || raw.ranks.length !== 4) fail();
  const seen = new Set<Side>();
  const ranks = raw.ranks.map((value) => {
    const rank = object(value);
    if (
      !sides.includes(rank.side as Side) ||
      seen.has(rank.side as Side) ||
      (rank.kind !== "provisional" && rank.kind !== "confirmed")
    )
      fail();
    seen.add(rank.side as Side);
    return {
      side: rank.side as Side,
      rank: number(rank.rank, 4),
      kind: rank.kind as "provisional" | "confirmed",
    };
  });
  return {
    evaluationKind: raw.evaluationKind as AiEvaluation["evaluationKind"],
    values,
    ranks,
    probabilities: null,
  };
}

const restored = new WeakMap<StudyRecordedAnalysis, Promise<readonly AiCandidate[]>>();

/** 保存PVの表示情報を信用せず、正本で再生した局面から王手・捕獲・脱落を復元します。 */
export function restoreRecordedCandidates(
  record: StudyRecordedAnalysis,
  position: AnalysisPosition,
): Promise<readonly AiCandidate[]> {
  if (record.stateHash !== position.stateHash) fail();
  const existing = restored.get(record);
  if (existing) return existing;
  const result = (async () => {
    if (record.stateHash !== position.stateHash) fail();
    return Promise.all(
      record.candidates.map(async (candidate): Promise<AiCandidate> => {
        let current = position;
        const line: AiLineStep[] = [];
        for (const [index, event] of candidate.events.entries()) {
          if (event.type !== "action") fail();
          const captured = current.state.board[event.action.to.y][event.action.to.x];
          const next = await advanceAnalysisPosition(current, event);
          const checked = getCheckState(next.state);
          line.push({
            side: event.side,
            action: event.action,
            afterPly: index + 1,
            nextTurn: next.state.status === "playing" ? next.state.turn : null,
            checkedSides: sides.filter((side) => checked[side]),
            captured,
            eliminations: next.state.eliminations.slice(current.state.eliminations.length),
            result: next.state.result,
          });
          current = next;
        }
        if (!line.length) fail();
        const root = position.state.turn;
        const returned = line.findIndex(
          (step) =>
            step.nextTurn === root ||
            step.result ||
            step.eliminations.some((entry) => entry.side === root),
        );
        const evidence = returned < 0 ? line : line.slice(0, returned + 1);
        return {
          action: line[0].action,
          evaluation: candidate.evaluation,
          completedDepth: record.completedDepth,
          iterationNodes: 0,
          iterationWork: 0,
          selective: true,
          cutoff: false,
          comparisonKind: "uniform_depth",
          visits: 0,
          lineEvaluation: candidate.evaluation,
          line,
          danger: {
            kind: "pv_example",
            forced: false,
            untilNextOwnTurn:
              returned < 0
                ? "horizon"
                : evidence.at(-1)?.result
                  ? "terminal"
                  : evidence.at(-1)?.nextTurn === root
                    ? "returned"
                    : "eliminated",
            evidence,
            alternatives: null,
          },
        };
      }),
    );
  })();
  restored.set(record, result);
  return result;
}

export async function parseRecordedAnalyses(
  value: unknown,
  positions: ReadonlyMap<string, AnalysisPosition>,
): Promise<Readonly<Record<string, StudyRecordedAnalysis>>> {
  const raw = object(value);
  const records: Record<string, StudyRecordedAnalysis> = {};
  for (const [nodeId, value] of Object.entries(raw)) {
    const position = positions.get(nodeId);
    if (!position) fail();
    const item = object(value);
    if (!Array.isArray(item.candidates) || item.candidates.length > 5 || !item.candidates.length)
      fail();
    const timeBudgetMs = item.timeBudgetMs === null ? null : number(item.timeBudgetMs, 3_600_000);
    const savedAt = text(item.savedAt);
    if (!Number.isFinite(Date.parse(savedAt))) fail();
    const record: StudyRecordedAnalysis = {
      stateHash: text(item.stateHash),
      savedAt,
      searchVersion: text(item.searchVersion),
      evaluationVersion: text(item.evaluationVersion),
      engineVersion: text(item.engineVersion),
      timeBudgetMs,
      threads: number(item.threads, 32),
      memoryMb: number(item.memoryMb, 65536),
      elapsedMs: number(item.elapsedMs),
      completedDepth: number(item.completedDepth, 256),
      evaluation: evaluation(item.evaluation),
      candidates: item.candidates.map((value) => {
        const candidate = object(value);
        if (
          !Array.isArray(candidate.events) ||
          candidate.events.length < 1 ||
          candidate.events.length > 264
        )
          fail();
        return {
          evaluation: evaluation(candidate.evaluation),
          events: candidate.events.map(validateAnalysisReplayEvent),
        };
      }),
    };
    if (record.completedDepth < 1 || record.threads < 1 || record.memoryMb < 256) fail();
    await restoreRecordedCandidates(record, position);
    Object.defineProperty(records, nodeId, { value: record, enumerable: true });
  }
  return records;
}
