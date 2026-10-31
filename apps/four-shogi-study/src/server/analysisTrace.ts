import { createHash } from "node:crypto";
import { mkdir, open, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { StudyAnalysisView, StudyLiveView } from "../contracts";
import type { StudyPositionInput, StudySettings } from "../shared/model";
import { validateStudyId } from "../domain/study";
import { aiVersions } from "@tetraboard/four-shogi/ai";

export type StudyAnalysisTrace = {
  studyId: string;
  nodeId: string;
  requestedAt: string;
  input: StudyPositionInput;
  settings: StudySettings;
  conditions: {
    timeBudgetMs: number | null;
    threads: number;
    memoryMb: number;
    cacheSize?: number;
  };
  auto: boolean;
  live: Pick<StudyLiveView, "instanceId" | "roundId" | "eventCount"> | null;
  analysis: StudyAnalysisView;
};

/** 診断用の記録です。保存候補の復元や現在手への採用には使いません。 */
export async function writeStudyAnalysisTrace(directory: string, record: StudyAnalysisTrace) {
  const id = validateStudyId(record.studyId);
  const job = validateStudyId(record.analysis.id);
  const guard = record.analysis.lethalGuard;
  const payload = {
    format: "four-shogi-study-analysis-trace-v1",
    savedAt: new Date().toISOString(),
    sourceRevision: process.env.STUDY_SOURCE_REVISION ?? null,
    engineVersion: aiVersions.engineVersion,
    ...record,
    analysis: {
      ...record.analysis,
      // 証明の全節点は大きいため、地平・判定・費用・危険手順を記録します。
      // この要約だけから証明を再検証できるとは扱いません。
      lethalGuard: guard
        ? {
            ...guard,
            originalCandidates: undefined,
            rows: guard.rows.map(({ candidate, proof, ...row }) => ({
              ...row,
              candidateDepth: candidate?.completedDepth ?? null,
              proof: proof
                ? { ...proof, nodeCount: Object.keys(proof.nodes).length, nodes: undefined }
                : null,
            })),
          }
        : undefined,
    },
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 8 * 1024 ** 2)
    throw new Error("思考ログが1件8MiBの保存上限を超えました");
  const folder = join(directory, "analysis-traces", id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const disk = await statfs(folder);
  if (disk.bavail * disk.bsize < 128 * 1024 ** 2)
    throw new Error("思考ログを保存する空き容量が不足しています");
  const file = join(folder, `${job}-${crypto.randomUUID()}.json`);
  const temporary = file + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({ checksum: createHash("sha256").update(body).digest("hex"), payload }) + "\n",
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return file;
}
