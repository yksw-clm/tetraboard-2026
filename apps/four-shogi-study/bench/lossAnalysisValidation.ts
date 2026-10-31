import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  restoreAnalysisPosition,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, sides } from "@tetraboard/four-shogi";
import type { AiCandidate } from "@tetraboard/four-shogi/ai";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { explainStudyEvaluation } from "../../../packages/four-shogi/src/studySearch";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import type { LossCase } from "./lossAnalysisCases";
import type { LossPolicyResult, LossFixedResult, LossRuntimeResult } from "./lossAnalysisWorker";
import { validateFiniteProof, type SafetyProof } from "./lossSafety";

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value !== null && typeof value === "object"
      ? "{" +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
          .join(",") +
        "}"
      : JSON.stringify(value);
function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
function result<T>(path: string): T | null {
  return existsSync(path) ? (read<{ result?: T }>(path).result ?? null) : null;
}

export async function validateLossArtifacts(directory: string) {
  const plan = read<{
    source: { core: string; runtime: string };
    cases: { id: string; caseHash: string }[];
  }>(join(directory, "plan.json"));
  const totals = {
    cases: 0,
    originalPv: 0,
    newPv: 0,
    pvSteps: 0,
    policyRows: 0,
    policySteps: 0,
    certificates: 0,
    verifiedCertificates: 0,
    unknownCertificates: 0,
    rootIndexMismatches: 0,
    lineEvaluationMismatches: 0,
  };
  const errors: { caseId: string; reason: string }[] = [];
  const perCase = [];
  const pv = async (position: AnalysisPosition, candidate: AiCandidate) => {
    let current = position;
    if (
      candidate.line.length &&
      encodeAction(candidate.line[0].action) !== encodeAction(candidate.action)
    )
      throw Error("候補初手とPVが相違します");
    for (const [index, step] of candidate.line.entries()) {
      const before = current;
      if (before.state.turn !== step.side || step.afterPly !== index + 1)
        throw Error("PVの手番/連番が不正です");
      current = await advanceAnalysisPosition(before, {
        type: "action",
        side: step.side,
        action: step.action,
      });
      const checks = getCheckState(current.state),
        checked = sides.filter((side) => checks[side]);
      if (
        current.state.turn !== step.nextTurn ||
        canonical(checked) !== canonical(step.checkedSides) ||
        canonical(current.state.lastMove?.captured ?? null) !== canonical(step.captured) ||
        canonical(current.state.eliminations.slice(before.state.eliminations.length)) !==
          canonical(step.eliminations) ||
        canonical(current.state.status === "finished" ? current.state.result : null) !==
          canonical(step.result)
      )
        throw Error("PVの捕獲/脱落/王手/結果が相違します");
      totals.pvSteps++;
    }
    if (
      candidate.lineEvaluation &&
      canonical(explainStudyEvaluation(current).evaluation) !== canonical(candidate.lineEvaluation)
    )
      totals.lineEvaluationMismatches++;
    return current.stateHash;
  };
  for (const item of plan.cases) {
    try {
      const record = read<LossCase>(join(directory, "cases", item.id + ".json"));
      if (hashJson(record) !== item.caseHash) throw Error("抽出入力のSHAが相違します");
      const position = await restoreAnalysisPosition(record.replay);
      if (
        position.stateHash !== record.stateHash ||
        canonical(
          getAnalysisLegalActions(position)
            .map(encodeAction)
            .sort((a, b) => a - b),
        ) !== canonical(record.legalActions.map(encodeAction).sort((a, b) => a - b))
      )
        throw Error("抽出局面/全合法手が相違します");
      for (const candidate of record.recordedChoice.search?.candidates ?? []) {
        await pv(position, candidate);
        totals.originalPv++;
      }
      const policy = result<LossPolicyResult>(
        join(directory, "counterfactual", item.id + "-policy.json"),
      );
      for (const row of policy?.rows ?? []) {
        let current = position,
          afterFirst: AnalysisPosition | null = null;
        if (encodeAction(row.action) !== row.actionId) throw Error("代替初手IDが相違します");
        if (
          row.rootIndex !== null &&
          encodeAction(record.legalActions[row.rootIndex]) !== row.actionId
        )
          totals.rootIndexMismatches++;
        for (const [index, step] of row.steps.entries()) {
          if (
            current.stateHash !== step.beforeHash ||
            step.event.type !== "action" ||
            current.state.turn !== step.event.side
          )
            throw Error("代替分岐の着手前が不正です");
          if (index === 0 && encodeAction(step.event.action) !== row.actionId)
            throw Error("代替初手を適用していません");
          current = await advanceAnalysisPosition(current, step.event);
          if (current.stateHash !== step.afterHash) throw Error("代替分岐の着手後が相違します");
          if (index === 0) afterFirst = current;
          totals.policySteps++;
        }
        if (
          !afterFirst ||
          canonical(explainStudyEvaluation(afterFirst).evaluation) !==
            canonical(row.staticEvaluation)
        )
          throw Error("代替初手後の静的評価が相違します");
        const alive = getActiveSides(current.state).includes(record.side);
        if (
          (row.status === "eliminated" && alive) ||
          ((row.status === "returned" || row.status === "terminal_alive") && !alive) ||
          (row.status === "returned" && current.state.turn !== record.side)
        )
          throw Error("代替分岐の終端判定が不正です");
        totals.policyRows++;
      }
      const runtime = result<LossRuntimeResult>(
        join(directory, "diagnostics", item.id + "-runtime.json"),
      );
      for (const candidate of [
        ...(runtime?.snapshot.candidates ?? []),
        ...(runtime?.snapshot.broadCandidates ?? []),
      ]) {
        await pv(position, candidate);
        totals.newPv++;
      }
      const majorPath = join(directory, "counterfactual", item.id + "-major.json");
      const major = existsSync(majorPath) ? read<{ actionIds: number[] }>(majorPath).actionIds : [];
      for (const actionId of major) {
        const fixed = result<LossFixedResult>(
          join(directory, "diagnostics", `${item.id}-fixed-${actionId}.json`),
        );
        for (const row of fixed?.results ?? []) {
          const candidate = row.candidate as AiCandidate | null;
          if (!candidate) continue;
          if (
            !(row.completion as { complete: boolean }).complete ||
            candidate.completedDepth !== row.depth
          )
            throw Error("未完成深さを候補に昇格しています");
          const hash = await pv(position, candidate);
          totals.newPv++;
          if (hash !== (row.pv as { leafHash: string }).leafHash)
            throw Error("固定探索のPV末尾hashが相違します");
        }
        const intervention =
          fixed && "intervention" in fixed
            ? (fixed.intervention as {
                steps?: {
                  candidate: AiCandidate | null;
                  depth: number;
                  completion: { complete: boolean };
                }[];
              } | null)
            : null;
        for (const row of intervention?.steps ?? []) {
          if (row.candidate) {
            if (!row.completion.complete || row.candidate.completedDepth !== row.depth)
              throw Error("介入の未完成を採用しています");
            await pv(position, row.candidate);
            totals.newPv++;
          }
        }
      }
      for (const name of readdirSync(join(directory, "counterfactual")).filter(
        (name) => name.startsWith(item.id + "-safety.json.") && name.endsWith(".certificate.json"),
      )) {
        const certificate = read<{
          caseId: string;
          actionId: number;
          horizon: number;
          proof: SafetyProof;
          validation: { verified: boolean };
        }>(join(directory, "counterfactual", name));
        if (
          certificate.caseId !== item.id ||
          certificate.horizon !== certificate.proof.horizon ||
          encodeAction(certificate.proof.action) !== certificate.actionId ||
          certificate.proof.horizon < 1 ||
          certificate.proof.horizon > 4
        )
          throw Error("有限証明の条件が不正です");
        const verified = await validateFiniteProof(position, certificate.proof);
        if (verified.verified !== certificate.validation.verified)
          throw Error("有限証明の保存後検証が相違します");
        totals.certificates++;
        if (verified.verified) totals.verifiedCertificates++;
        else totals.unknownCertificates++;
      }
      totals.cases++;
      perCase.push({ caseId: item.id, verified: true });
    } catch (error) {
      errors.push({
        caseId: item.id,
        reason: String(error).replaceAll(directory, "<ARTIFACT_ROOT>"),
      });
      perCase.push({ caseId: item.id, verified: false });
    }
  }
  const report = {
    schemaVersion: 1,
    validationSourceSha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
    totals,
    errors,
    cases: perCase,
    allStructuralChecksValid: errors.length === 0 && totals.rootIndexMismatches === 0,
    evaluationMatches: totals.lineEvaluationMismatches === 0,
  };
  writeFileSync(
    join(directory, "validation/serialized-artifacts.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
if (import.meta.main)
  console.log(JSON.stringify(await validateLossArtifacts(resolve(Bun.argv[2]))));
