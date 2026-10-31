import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import {
  advanceAnalysisPosition,
  type AnalysisPosition,
} from "../../../packages/four-shogi/src/analysis";
import { getActiveSides } from "../../../packages/four-shogi/src/types";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import {
  explainStudyEvaluation,
  compareStudyCandidates,
} from "../../../packages/four-shogi/src/studySearch";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudyPositionInput } from "../src/shared/model";
import type { AiEvaluation, AiLineStep } from "../../../packages/four-shogi/src/aiTypes";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function verifyRefinementLine(
  position: AnalysisPosition,
  candidate: { line: readonly AiLineStep[]; evaluation: AiEvaluation; completedDepth: number },
  extensions = 2,
) {
  if (
    !Number.isSafeInteger(candidate.completedDepth) ||
    candidate.completedDepth < 1 ||
    !Number.isSafeInteger(extensions) ||
    extensions < 0 ||
    extensions > 4
  )
    throw new Error("深さ・延長予算が不正です");
  if (!candidate.line.length && position.state.status === "playing")
    throw new Error("完成PVがありません");
  let current = position;
  for (const [index, step] of candidate.line.entries()) {
    if (current.state.turn !== step.side) throw new Error("PVの実手番が一致しません");
    const before = current.state;
    current = await advanceAnalysisPosition(current, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    const checks = getCheckState(current.state);
    if (
      step.afterPly !== index + 1 ||
      step.nextTurn !== current.state.turn ||
      hash(step.checkedSides) !==
        hash(getActiveSides(current.state).filter((side) => checks[side])) ||
      hash(step.captured) !== hash(current.state.lastMove?.captured ?? null) ||
      hash(step.result) !== hash(current.state.result) ||
      hash(step.eliminations) !== hash(current.state.eliminations.slice(before.eliminations.length))
    )
      throw new Error("PVの着手メタデータが一致しません");
  }
  if (candidate.line.length > candidate.completedDepth + extensions)
    throw new Error("延長上限を超えています");
  if (hash(explainStudyEvaluation(current).evaluation) !== hash(candidate.evaluation))
    throw new Error("PV末尾の評価が一致しません");
  return {
    plies: candidate.line.length,
    extra: candidate.line.length - candidate.completedDepth,
    finalStateHash: current.stateHash,
  };
}

export async function verifyRefinementFile(path: string) {
  const records = (await Bun.file(path).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const header = records[0];
  if (header.kind !== "header" || header.schemaVersion !== 1) throw new Error("結果形式が不正です");
  const measured = header.reportMetadata.fixed.source;
  for (const [key, folder] of [
    ["engine", "packages/four-shogi/src"],
    ["runtime", "apps/four-shogi-study/src/search"],
    ["fixtures", "packages/four-shogi/bench"],
  ] as const)
    if (sourceIdentity(resolve(repoRoot, folder)).sha256 !== measured[key].sha256)
      throw new Error(`測定ソースと異なります: ${key}`);
  const file = records.find((record) => record.kind === "inputFile");
  if (
    !file ||
    createHash("sha256").update(file.data.text).digest("hex") !== header.inputMaster.sha256
  )
    throw new Error("固定入力ファイルのSHAが一致しません");
  const inputs = new Map<string, StudyPositionInput>();
  const positions = new Map<string, AnalysisPosition>();
  for (const record of records.filter((record) => record.kind === "input")) {
    if (inputs.has(record.id)) throw new Error("入力IDが重複しています");
    inputs.set(record.id, record.data);
  }
  for (const input of JSON.parse(file.data.text))
    if (hash(inputs.get(input.id)) !== hash(input.input))
      throw new Error("性能入力の内容が一致しません");
  let checked = 0,
    matches = 0,
    events = 0,
    maxExtra = 0,
    pending = 0;
  const byKind: Record<string, number> = {};
  async function positionFor(id: string) {
    const cached = positions.get(id);
    if (cached) return cached;
    const input = inputs.get(id);
    if (!input) throw new Error(`入力がありません: ${id}`);
    const position = await restoreStudyPosition(input);
    positions.set(id, position);
    return position;
  }
  async function check(row: any, candidate: any, kind: string, extensions = 2) {
    const position = await positionFor(row.inputRef ?? row.id);
    if (row.stateHash && position.stateHash !== row.stateHash)
      throw new Error("入力局面ハッシュが一致しません");
    const result = await verifyRefinementLine(position, candidate, extensions);
    maxExtra = Math.max(maxExtra, result.extra);
    checked++;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  for (const record of records) {
    const row = record.data;
    if (!row) continue;
    if (record.kind === "fixed" || record.kind === "controls") {
      if (!row.comparison.complete && row.comparison.selectedRootIndex !== undefined)
        throw new Error("未完成比較から推奨を作っています");
      if (row.comparison.complete) {
        const position = await positionFor(row.inputRef ?? row.id);
        const candidates = row.comparison.rows
          .map((task: any) => task.candidate)
          .filter(Boolean)
          .map((candidate: any) => ({
            ...candidate,
            lineEvaluation: candidate.lineEvaluation ?? candidate.evaluation,
          }));
        candidates.sort((a: any, b: any) => compareStudyCandidates(a, b, position.state.turn!));
        if (!candidates.length || candidates[0].rootIndex !== row.comparison.selectedRootIndex)
          throw new Error("完成比較の推奨が一致しません");
      }
      for (const task of row.comparison.rows)
        if (task.candidate) {
          if (!task.completion.complete) throw new Error("未完了タスクに完成候補があります");
          await check(row, task.candidate, record.kind);
        }
    } else if (record.kind === "profile" || record.kind === "variance") {
      for (const candidate of row.snapshot.candidates)
        await check(row, candidate, record.kind, row.extensions ?? 2);
    } else if (record.kind === "tactic") {
      if (row.principalVariation.length && row.evaluation)
        await check(
          row,
          {
            line: row.principalVariation,
            evaluation: row.evaluation,
            completedDepth: row.completedDepth,
          },
          record.kind,
        );
      else pending++;
      for (const candidate of row.candidates ?? [])
        await check(row, candidate, "tactic-failed-candidate");
    } else if (record.kind === "performance" || record.kind === "cpuPerformance") {
      if (row.search.evaluation && row.search.principalVariation.length)
        await check(
          row,
          {
            line: row.search.principalVariation,
            evaluation: row.search.evaluation,
            completedDepth: row.search.completedDepth,
          },
          record.kind,
        );
      else pending++;
    } else if (record.kind === "match") {
      const position = await restoreStudyPosition({
        origin: { kind: "replay", replay: row.replay },
        events: [],
      });
      if (
        position.stateHash !== row.sample.finalStateHash ||
        (position.state.status === "finished" ? "finished" : "unfinished") !== row.sample.status
      )
        throw new Error("対局の再生結果が一致しません");
      if (hash(row.replay.events) !== row.sample.trajectoryHash)
        throw new Error("対局手順のSHAが一致しません");
      matches++;
      events += row.replay.events.length;
    }
  }
  return {
    allMatch: true,
    checked,
    byKind,
    pending,
    matches,
    events,
    maximumExtraPlies: maxExtra,
    measurementCommit: header.measurementCommit,
  };
}

if (import.meta.main) {
  const path = Bun.argv[2];
  if (!path) throw new Error("結果JSONLのパスを指定してください");
  const result = await verifyRefinementFile(path);
  console.log(JSON.stringify(result));
  if (Bun.argv[3]) await Bun.write(Bun.argv[3], JSON.stringify(result, null, 2) + "\n");
}
