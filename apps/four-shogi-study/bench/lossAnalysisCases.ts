import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  restoreAnalysisPosition,
  type AnalysisReplayInput,
  type FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, type FourShogiAction, type Side } from "@tetraboard/four-shogi";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { hashJson, resultLabels } from "../../../packages/four-shogi/bench/singlesMeasurement";
import {
  explainStudyEvaluation,
  type StudySearchStrategy,
  type StudyTaskPolicy,
} from "../../../packages/four-shogi/src/studySearch";
import { readStrengthJournal, type StrengthJournalEntry } from "./strengthJournal";
import type { RecordedGame, StrengthChoice } from "./strength";
import { comparePilotLine } from "./strengthPilotDiagnostics";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";

export const lossAnalysisLimits = Object.freeze({
  wallMs: 60 * 60000,
  workers: 4,
  memoryMb: 4096,
  softRssMiB: 6144,
  hardRssMiB: 7168,
  runtimeMs: 2000,
  fixedDepths: [2, 4, 6],
  fixedWork: 100000,
  fixedMs: 2000,
  majorActions: 6,
  policyPlies: 8,
  policyActionMs: 2000,
  policyCaseMs: 20000,
  safetyHorizons: [1, 2, 3, 4],
  safetyTransitions: 2500,
  safetyQueryMs: 500,
  safetyCaseMs: 20000,
  traceBytes: 2 * 1024 * 1024,
  caseBytes: 16 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024,
});
export function lossSourceIdentity() {
  return {
    commit: git("rev-parse", "HEAD"),
    core: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")).sha256,
    runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")).sha256,
    analysis: [
      "lossAnalysis.ts",
      "lossAnalysisCases.ts",
      "lossAnalysisWorker.ts",
      "lossSafety.ts",
      "lossAnalysisGuard.py",
    ].map((path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256")
        .update(readFileSync(join(import.meta.dir, path)))
        .digest("hex"),
    })),
  };
}
export type LossCase = {
  id: string;
  kind: "loss" | "win-control";
  role: "last" | "previous" | "prior-nonforced" | "control-4" | "control-3";
  gameId: string;
  strategy: StudySearchStrategy;
  side: Side;
  restricted: boolean;
  eventIndex: number;
  stateHash: string;
  activeSides: Side[];
  replay: AnalysisReplayInput;
  chosenAction: FourShogiAction;
  legalActions: FourShogiAction[];
  recordedChoice: StrengthChoice;
  historicalTop3Only: true;
  taskPolicy: StudyTaskPolicy | null;
  depths: number[];
  actualSuffix: {
    index: number;
    event: FourShogiReplayEvent;
    beforeHash: string;
    afterHash: string;
  }[];
  eliminationEventIndex: number | null;
  pliesAfterChosenAction: number | null;
  divergence: ReturnType<typeof comparePilotLine> | null;
  inputEvaluation: ReturnType<typeof explainStudyEvaluation>;
  recordedPvValidation: {
    plies: number;
    legal: boolean;
    leafHash: string | null;
    leafEvaluation: ReturnType<typeof explainStudyEvaluation> | null;
  };
};
type MoveRow = Extract<StrengthJournalEntry, { type: "move" }>;

export function selectLossTurns(rows: readonly MoveRow[]) {
  const own = rows.filter((row) => row.choice);
  const selected = own.slice(-2).map((row, index, array) => ({
    row,
    role: (index === array.length - 1 ? "last" : "previous") as LossCase["role"],
  }));
  const lastNonforced = [...own]
    .reverse()
    .find((row) => row.choice!.reason !== "forced_legal_action");
  if (lastNonforced && !selected.some(({ row }) => row.event.index === lastNonforced.event.index))
    selected.push({ row: lastNonforced, role: "prior-nonforced" });
  return selected;
}

export async function extractLossCases(inputDirectory: string, outputDirectory: string) {
  mkdirSync(join(outputDirectory, "cases"), { recursive: true });
  const checkpoint = JSON.parse(readFileSync(join(inputDirectory, "checkpoint.json"), "utf8")) as {
    games: RecordedGame[];
    planHash: string;
  };
  if (
    checkpoint.games.length !== 24 ||
    new Set(checkpoint.games.map((game) => game.jobId)).size !== 24
  )
    throw Error("主比較24局の集合が不正です");
  const firstWins = new Map<StudySearchStrategy, string>();
  for (const game of checkpoint.games)
    if (game.sample.soleFirst && !firstWins.has(game.searchStrategy!))
      firstWins.set(game.searchStrategy!, game.jobId);
  const cases: LossCase[] = [],
    validations = [];
  for (const game of checkpoint.games) {
    const rows = readStrengthJournal(
      join(inputDirectory, "games/journals", `${game.jobId}.jsonl`),
    ).entries;
    const moves = rows.filter((row): row is MoveRow => row.type === "move");
    const loss = game.sample.status === "finished" && game.sample.rank !== 1;
    const selected = loss ? selectLossTurns(moves) : [];
    const targets = new Map(selected.map((item) => [item.row.event.index, item.role]));
    const controls = new Map<number, LossCase>();
    let position = await restoreAnalysisPosition({
      ...game.replay,
      events: game.replay.events.slice(0, 12),
    });
    let eliminationEventIndex: number | null = null;
    const gameCases: LossCase[] = [];
    for (const [offset, row] of moves.entries()) {
      if (position.stateHash !== row.beforeHash) throw Error("元棋譜の着手前hashが一致しません");
      const active = getActiveSides(position.state);
      const control =
        firstWins.get(game.searchStrategy!) === game.jobId &&
        row.choice?.reason !== "forced_legal_action" &&
        row.choice &&
        (active.length === 3 || active.length === 4);
      if (targets.has(row.event.index) || control) {
        const choice = row.choice!;
        if (!choice?.action || position.state.turn !== game.sample.seat)
          throw Error("抽出対象の自手番が不正です");
        const legal = getAnalysisLegalActions(position);
        if (!legal.some((action) => encodeAction(action) === encodeAction(choice.action!)))
          throw Error("記録手が非合法です");
        const chosenCandidate = choice.search?.candidates.find(
          (candidate) => encodeAction(candidate.action) === encodeAction(choice.action!),
        );
        let pvPosition = position;
        for (const [pvIndex, step] of (chosenCandidate?.line ?? []).entries()) {
          if (pvPosition.state.turn !== step.side) throw Error("記録PVの手番が不正です");
          pvPosition = await advanceAnalysisPosition(pvPosition, {
            type: "action",
            side: step.side,
            action: step.action,
          });
          if (pvIndex + 1 !== step.afterPly || pvPosition.state.turn !== step.nextTurn)
            throw Error("記録PVの着手情報が一致しません");
        }
        const coverage = choice.search?.coverage;
        const record: LossCase = {
          id: `${game.jobId.slice(0, 16)}-${row.event.index}`,
          kind: loss ? "loss" : "win-control",
          role: targets.get(row.event.index) ?? (active.length === 4 ? "control-4" : "control-3"),
          gameId: game.jobId,
          strategy: game.searchStrategy!,
          side: game.sample.seat,
          restricted: game.restricted,
          eventIndex: row.event.index,
          stateHash: position.stateHash,
          activeSides: [...active],
          replay: { ...game.replay, events: game.replay.events.slice(0, row.event.index) },
          chosenAction: choice.action,
          legalActions: [...legal],
          recordedChoice: choice,
          historicalTop3Only: true,
          taskPolicy:
            coverage?.phase === "deep"
              ? { phase: "deep", width: coverage.opponentWidth, ownWidth: coverage.ownWidth }
              : null,
          depths: [
            ...new Set([
              ...lossAnalysisLimits.fixedDepths,
              ...(choice.depth >= 2 && choice.depth <= 9 ? [choice.depth] : []),
            ]),
          ].sort((a, b) => a - b),
          actualSuffix: moves.slice(offset).map((value) => ({
            index: value.event.index,
            event: value.event.event,
            beforeHash: value.beforeHash,
            afterHash: value.afterHash,
          })),
          eliminationEventIndex: null,
          pliesAfterChosenAction: null,
          divergence: chosenCandidate
            ? comparePilotLine(
                chosenCandidate.line,
                moves.slice(offset).map((value) => value.event.event),
                game.sample.seat,
              )
            : null,
          inputEvaluation: explainStudyEvaluation(position),
          recordedPvValidation: {
            plies: chosenCandidate?.line.length ?? 0,
            legal: true,
            leafHash: chosenCandidate ? pvPosition.stateHash : null,
            leafEvaluation: chosenCandidate ? explainStudyEvaluation(pvPosition) : null,
          },
        };
        if (loss) gameCases.push(record);
        else controls.set(active.length, record);
      }
      position = await advanceAnalysisPosition(position, row.event.event);
      if (position.stateHash !== row.afterHash) throw Error("元棋譜の着手後hashが一致しません");
      if (
        eliminationEventIndex === null &&
        position.state.eliminations.some((entry) => entry.side === game.sample.seat)
      )
        eliminationEventIndex = row.event.index;
    }
    if (
      position.stateHash !== game.sample.finalStateHash ||
      hashJson(resultLabels(position.state, game.sample.seat)) !==
        hashJson({
          rank: game.sample.rank,
          soleFirst: game.sample.soleFirst,
          tiedFirst: game.sample.tiedFirst,
          noSoleWinner: game.sample.noSoleWinner,
        })
    )
      throw Error("元の終局・順位が一致しません");
    for (const record of gameCases) {
      if (eliminationEventIndex === null) throw Error("敗退局の脱落が見つかりません");
      record.eliminationEventIndex = eliminationEventIndex;
      record.pliesAfterChosenAction = eliminationEventIndex - record.eventIndex;
      record.actualSuffix = record.actualSuffix.filter(
        (step) => step.index <= eliminationEventIndex,
      );
    }
    cases.push(...gameCases, ...controls.values());
    validations.push({
      gameId: game.jobId,
      loss,
      events: game.replay.events.length,
      finalStateHash: position.stateHash,
      verified: true,
    });
  }
  const sorted = cases.sort((a, b) => {
    const weight = (value: LossCase) =>
      value.kind === "win-control"
        ? 3
        : value.role === "last"
          ? 0
          : value.role === "previous"
            ? 1
            : 2;
    return weight(a) - weight(b) || a.id.localeCompare(b.id);
  });
  if (
    new Set(sorted.filter((record) => record.kind === "loss").map((record) => record.gameId))
      .size !== 15
  )
    throw Error("敗退15局が揃いません");
  for (const record of sorted)
    writeFileSync(
      join(outputDirectory, "cases", record.id + ".json"),
      JSON.stringify(record) + "\n",
    );
  return {
    cases: sorted.map((record) => ({
      id: record.id,
      gameId: record.gameId,
      kind: record.kind,
      role: record.role,
      strategy: record.strategy,
      stateHash: record.stateHash,
      legalMoves: record.legalActions.length,
      active: record.activeSides.length,
    })),
    validations,
    inputPlanHash: checkpoint.planHash,
    inputCheckpointSha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(inputDirectory, "checkpoint.json")))
      .digest("hex"),
  };
}
