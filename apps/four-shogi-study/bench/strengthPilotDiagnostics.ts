import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  advanceAnalysisPosition,
  restoreAnalysisPosition,
  type FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";
import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import { getCheckState, pieces } from "../../../packages/four-shogi/src/board";
import { pieceValue } from "../../../packages/four-shogi/src/cpuEvaluation";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { readStrengthJournal } from "./strengthJournal";
import type { RecordedGame } from "./strength";
import { pilotStrategies } from "./strengthPilotResults";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";

type LineStep = { side: Side; action: FourShogiAction };

/** 同じseed・席・禁止設定を束ね、完成した3方式だけを対応比較します。 */
export function pilotPairedComparisons(games: readonly RecordedGame[]) {
  if (new Set(games.map((game) => game.jobId)).size !== games.length)
    throw new Error("重複した対局を比較できません");
  const result = [];
  for (const seed of [...new Set(games.map((game) => game.sample.seed))].sort((a, b) => a - b)) {
    const cells = new Map<string, RecordedGame[]>();
    for (const game of games.filter((value) => value.sample.seed === seed)) {
      const key = `${game.restricted}/${game.sample.seat}`;
      cells.set(key, [...(cells.get(key) ?? []), game]);
    }
    const matched = [...cells.values()].filter(
      (cell) =>
        cell.length === 3 &&
        pilotStrategies.every((strategy) =>
          cell.some(
            (game) => game.searchStrategy === strategy && game.sample.status === "finished",
          ),
        ),
    );
    const complete = matched.length === 8;
    for (let leftIndex = 0; leftIndex < pilotStrategies.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < pilotStrategies.length; rightIndex++) {
        const left = pilotStrategies[leftIndex],
          right = pilotStrategies[rightIndex];
        const differences = matched.map((cell) => {
          const a = cell.find((game) => game.searchStrategy === left)!;
          const b = cell.find((game) => game.searchStrategy === right)!;
          let firstDifference = null;
          for (
            let index = 0;
            index < Math.min(a.replay.events.length, b.replay.events.length);
            index++
          ) {
            const l = a.replay.events[index].event,
              r = b.replay.events[index].event;
            if (l.type !== "action" || r.type !== "action")
              throw new Error("実戦比較はaction棋譜です");
            if (l.side !== r.side || encodeAction(l.action) !== encodeAction(r.action)) {
              firstDifference = {
                eventIndex: index,
                additionalPly: index - 11,
                leftSide: l.side,
                rightSide: r.side,
                candidateDecision: l.side === a.sample.seat && r.side === a.sample.seat,
                leftAction: l.action,
                rightAction: r.action,
                commonPrefixHash: hashJson({
                  ...a.replay,
                  events: a.replay.events.slice(0, index),
                }),
              };
              break;
            }
          }
          return {
            restricted: a.restricted,
            seat: a.sample.seat,
            leftJobId: a.jobId,
            rightJobId: b.jobId,
            soleFirstDifference: Number(b.sample.soleFirst) - Number(a.sample.soleFirst),
            rankDifference: b.sample.rank! - a.sample.rank!,
            firstDifference,
          };
        });
        result.push({
          seed,
          left,
          right,
          completeSeed: complete,
          matchedCells: differences.length,
          differenceDirection: "right-minus-left",
          primarySoleFirstRateDifference: complete
            ? differences.reduce((sum, row) => sum + row.soleFirstDifference, 0) / 8
            : null,
          primaryMeanRankDifference: complete
            ? differences.reduce((sum, row) => sum + row.rankDifference, 0) / 8
            : null,
          referenceCells: differences,
        });
      }
    }
  }
  return {
    independentSeeds: new Set(games.map((game) => game.sample.seed)).size,
    interval: null,
    comparisons: result,
  };
}
export function comparePilotLine(
  line: readonly LineStep[],
  actual: readonly FourShogiReplayEvent[],
  root: Side,
) {
  let matchingPlies = 0;
  let firstDivergence: { at: number; expectedSide: Side; actualSide: Side | null } | null = null;
  for (let index = 0; index < Math.min(line.length, actual.length); index++) {
    const event = actual[index];
    if (
      event.type !== "action" ||
      line[index].side !== event.side ||
      encodeAction(line[index].action) !== encodeAction(event.action)
    ) {
      firstDivergence = {
        at: index,
        expectedSide: line[index].side,
        actualSide: event.type === "action" ? event.side : null,
      };
      break;
    }
    matchingPlies++;
  }
  const ownReturn = line.findIndex((step, index) => index > 0 && step.side === root);
  return {
    matchingPlies,
    firstDivergence,
    predictedPlies: line.length,
    pvReachesNextOwnMove: ownReturn >= 0,
    actualPrefixExhausted: !firstDivergence && actual.length < line.length,
  };
}

export async function diagnosePilot(directory: string) {
  const checkpoint = JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8")) as {
    games: RecordedGame[];
    planHash: string;
  };
  const reports = [];
  for (const game of checkpoint.games) {
    const rows = readStrengthJournal(
      join(directory, "games/journals", `${game.jobId}.jsonl`),
    ).entries;
    const moves = rows.filter((row) => row.type === "move");
    let position = await restoreAnalysisPosition({
      ...game.replay,
      events: game.replay.events.slice(0, 12),
    });
    const captures: {
      ply: number;
      captor: Side;
      victim: Side;
      kind: string;
      promoted: boolean;
      value: number;
      victimActive: boolean;
    }[] = [];
    const choices = [];
    const checks = [];
    let candidateElimination: {
      ply: number;
      reason: string;
      rank: number | null;
      beforeGameEnd: boolean;
    } | null = null;
    let lastChoice = -1;
    for (const [index, row] of moves.entries()) {
      const root = game.sample.seat;
      if (row.choice) {
        const action = row.choice.action;
        if (!action) throw new Error("適用済み候補手がありません");
        const selected = row.choice.search?.candidates.find(
          (candidate) => encodeAction(candidate.action) === encodeAction(action),
        );
        const comparison = selected
          ? comparePilotLine(
              selected.line,
              game.replay.events.slice(12 + index).map((value) => value.event),
              root,
            )
          : null;
        choices.push({
          ply: index + 1,
          depth: row.choice.depth,
          reason: row.choice.reason,
          elapsedMs: row.choice.elapsedMs,
          coverage: row.choice.search?.coverage ?? null,
          legalRoots: row.choice.search?.diagnostics.legalRoots ?? null,
          selectedRoots: row.choice.search?.diagnostics.selectedRoots ?? null,
          comparison,
          ownValue: row.choice.search?.evaluation?.values[root] ?? null,
          gapFromPriorOwnChoice: lastChoice >= 0 ? index - lastChoice : null,
        });
        lastChoice = index;
      }
      const before = position;
      position = await advanceAnalysisPosition(position, row.event.event);
      if (position.stateHash !== row.afterHash) throw Error("診断の正本hashが一致しません");
      const captured = position.state.lastMove?.captured;
      if (captured && row.event.event.type === "action")
        captures.push({
          ply: index + 1,
          captor: row.event.event.side,
          victim: captured.side,
          kind: captured.kind,
          promoted: captured.promoted,
          value: pieceValue(captured),
          victimActive: !before.state.eliminations.some((entry) => entry.side === captured.side),
        });
      const checking = getCheckState(position.state);
      if (
        row.event.event.type === "action" &&
        row.event.event.side === root &&
        Object.values(checking).some(Boolean)
      )
        checks.push({
          ply: index + 1,
          checkedSides: Object.entries(checking)
            .filter(([, value]) => value)
            .map(([side]) => side),
          nextTurn: position.state.turn,
        });
      const elimination = position.state.eliminations.find((entry) => entry.side === root);
      if (
        !candidateElimination &&
        elimination &&
        !before.state.eliminations.some((entry) => entry.side === root)
      )
        candidateElimination = {
          ply: index + 1,
          reason: elimination.reason,
          rank: elimination.rank,
          beforeGameEnd: position.state.status !== "finished",
        };
    }
    const root = game.sample.seat;
    const searched = choices.filter((choice) => choice.reason !== "forced_legal_action");
    const withPv = searched.filter(
      (choice) => choice.comparison && choice.comparison.predictedPlies > 0,
    );
    const diverged = withPv.filter((choice) => choice.comparison!.firstDivergence);
    reports.push({
      jobId: game.jobId,
      strategy: game.searchStrategy,
      seed: game.sample.seed,
      seat: root,
      restricted: game.restricted,
      status: game.sample.status,
      rank: game.sample.rank,
      soleFirst: game.sample.soleFirst,
      termination: game.sample.termination,
      moves: game.sample.moves,
      candidateElimination,
      ownChecks: checks,
      ownCapturedPieces: captures.filter((event) => event.victim === root),
      ownCaptures: captures.filter((event) => event.captor === root),
      otherPlayerCaptures: captures.filter(
        (event) => event.victim !== root && event.captor !== root,
      ),
      remainingPieces: pieces(position.state.board)
        .filter((entry) => entry.piece.side === root)
        .map((entry) => ({ kind: entry.piece.kind, promoted: entry.piece.promoted })),
      searched: searched.length,
      pvAvailable: withPv.length,
      pvReachesOwnMove: withPv.filter((choice) => choice.comparison!.pvReachesNextOwnMove).length,
      pvDiverged: diverged.length,
      pvDivergedAtOpponent: diverged.filter(
        (choice) => choice.comparison!.firstDivergence!.expectedSide !== root,
      ).length,
      choices,
    });
  }
  const result = {
    schemaVersion: 1,
    planHash: checkpoint.planHash,
    analysisSourceSha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
    interpretation:
      "PVは選択した応手の一例で、相手の全合法応手への保証ではありません。PVと実対局の相違・駒の捕獲だけで悪手や評価関数の欠陥を確定しません。",
    games: reports,
  };
  writeFileSync(
    join(directory, "diagnostics/game-analysis.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  writeFileSync(
    join(directory, "statistics/paired-comparisons.json"),
    JSON.stringify(pilotPairedComparisons(checkpoint.games), null, 2) + "\n",
  );
  return result;
}
if (import.meta.main)
  for (const directory of Bun.argv.slice(2))
    console.log(
      JSON.stringify({ directory, games: (await diagnosePilot(resolve(directory))).games.length }),
    );
