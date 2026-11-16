import { z } from "zod";
import {
  readStoredMatch,
  publicMatchDetail,
  matchDetail,
} from "../src/accounts/matchDataContracts";
import { snapshotRecord, isEventReplay } from "../src/rooms/eventRecord";
import {
  encodeSnapshotMatch,
  rebuildSnapshotMatch,
  type SnapshotMatch,
} from "../src/rooms/snapshotMatchEvents";
import { verifyFinalState } from "../src/rooms/snapshotMatchStore";
import { conversionSql, rollbackSql, sqlStatementLimit } from "./snapshotMatchSql";

const exportRowSchema = z.object({
  id: z.string().min(1),
  game: z.string(),
  record_json: z.string(),
});
export type ExportRow = z.infer<typeof exportRowSchema>;
export function readMatchExport(value: unknown): ExportRow[] {
  return z
    .array(z.object({ results: z.array(exportRowSchema), success: z.literal(true).optional() }))
    .parse(value)
    .flatMap((entry) => entry.results);
}
const matchInfoSchema = z.object({
  id: z.string().min(1),
  game: z.string(),
  steps: z.int().nonnegative(),
});
export const conversionReportSchema = z.object({
  version: z.literal(1),
  games: z.record(
    z.string(),
    z.object({ input: z.int(), converted: z.int(), skipped: z.int(), failed: z.int() }),
  ),
  converted: z.array(matchInfoSchema),
  skipped: z.array(z.object({ id: z.string(), game: z.string(), reason: z.string() })),
  failed: z.array(z.object({ id: z.string(), game: z.string(), reason: z.string() })),
  batches: z.array(z.object({ sql: z.string(), rollback: z.string(), ids: z.array(z.string()) })),
});
export type ConversionReport = z.infer<typeof conversionReportSchema>;
type PlannedMatch = {
  info: z.infer<typeof matchInfoSchema>;
  statements: string[];
  rollback: string[];
};

function verifyAndPlan(row: ExportRow, limit: number): PlannedMatch {
  const original = readStoredMatch(row.record_json, row.game);
  if (original.game === "shogi" || original.game === "four-shogi")
    throw new Error("Expected snapshot game");
  const record = snapshotRecord<SnapshotMatch>(original.record);
  if (row.id !== record.id) throw new Error("Export row ID does not match record ID");
  const encoded = encodeSnapshotMatch(record);
  const restored = readStoredMatch(
    JSON.stringify(
      rebuildSnapshotMatch(
        readStoredMatch(JSON.stringify(encoded.record), row.game),
        encoded.events,
      ),
    ),
    row.game,
  );
  verifyFinalState(restored);
  if (JSON.stringify(restored.record) !== JSON.stringify(original.record))
    throw new Error("Match event replay does not match saved steps");
  const profiles = new Map();
  if (
    JSON.stringify(publicMatchDetail(original, profiles)) !==
    JSON.stringify(publicMatchDetail(restored, profiles))
  )
    throw new Error("Public match detail mismatch");
  for (const player of record.participants) {
    if (
      JSON.stringify(matchDetail(original, player.id, profiles)) !==
      JSON.stringify(matchDetail(restored, player.id, profiles))
    )
      throw new Error(`Participant match detail mismatch: ${player.id}`);
  }
  // 読取り時の既定値を元の保存JSONへ混ぜず、rollbackでは省略項目も元どおりにします。
  const raw = JSON.parse(row.record_json) as { replay: typeof record.replay };
  return {
    info: { id: row.id, game: row.game, steps: record.replay.steps.length },
    statements: conversionSql(record, encoded, limit),
    rollback: rollbackSql(record, raw.replay, limit),
  };
}

export function planSnapshotMatches(
  rows: ExportRow[],
  options: { batchSize?: number; statementLimit?: number } = {},
) {
  const { batchSize = 50, statementLimit = sqlStatementLimit } = options;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid batch size");
  if (
    !Number.isSafeInteger(statementLimit) ||
    statementLimit < 1 ||
    statementLimit > sqlStatementLimit
  )
    throw new Error("Invalid statement limit");
  const report: ConversionReport = {
    version: 1,
    games: Object.create(null),
    converted: [],
    skipped: [],
    failed: [],
    batches: [],
  };
  const planned = planRows(rows, report, statementLimit);
  const files: Record<string, string> = {};
  for (let start = 0; start < planned.length; start += batchSize) {
    const batch = planned.slice(start, start + batchSize);
    const number = String(report.batches.length + 1).padStart(3, "0");
    const sql = `batch-${number}.sql`,
      rollback = `rollback-${number}.sql`;
    files[sql] = batch.flatMap((match) => match.statements).join("\n") + "\n";
    files[rollback] = batch.flatMap((match) => match.rollback).join("\n") + "\n";
    report.batches.push({ sql, rollback, ids: batch.map((match) => match.info.id) });
  }
  return { report, files };
}

function planRows(rows: ExportRow[], report: ConversionReport, limit: number): PlannedMatch[] {
  const grouped = new Map<string, ExportRow[]>();
  for (const row of rows) {
    grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
    const counts = (report.games[row.game] ??= { input: 0, converted: 0, skipped: 0, failed: 0 });
    counts.input++;
  }
  const planned: PlannedMatch[] = [];
  for (const [id, entries] of grouped) {
    const row = entries[0];
    if (entries.some((other) => other.game !== row.game || other.record_json !== row.record_json)) {
      report.failed.push({ id, game: row.game, reason: "Conflicting duplicate export rows" });
      for (const entry of entries) report.games[entry.game].failed++;
      continue;
    }
    for (const _duplicate of entries.slice(1)) {
      report.skipped.push({ id, game: row.game, reason: "duplicate-input" });
      report.games[row.game].skipped++;
    }
    planRow(row, report, planned, limit);
  }
  return planned;
}

function planRow(row: ExportRow, report: ConversionReport, planned: PlannedMatch[], limit: number) {
  const counts = report.games[row.game];
  try {
    const raw = JSON.parse(row.record_json) as { replay?: unknown };
    const reason =
      row.game === "shogi" || row.game === "four-shogi"
        ? "shogi"
        : isEventReplay(raw.replay)
          ? "already-events"
          : null;
    if (reason) {
      report.skipped.push({ id: row.id, game: row.game, reason });
      counts.skipped++;
      return;
    }
    const match = verifyAndPlan(row, limit);
    planned.push(match);
    report.converted.push(match.info);
    counts.converted++;
  } catch (error) {
    report.failed.push({
      id: row.id,
      game: row.game,
      reason: error instanceof Error ? error.message : String(error),
    });
    counts.failed++;
  }
}
