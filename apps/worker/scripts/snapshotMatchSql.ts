import { matchChunkSize, readMatchChunk } from "../src/rooms/matchChunks";
import {
  encodeSnapshotMatch,
  matchEventSchema,
  type SnapshotMatch,
} from "../src/rooms/snapshotMatchEvents";

export const sqlStatementLimit = 100_000;
export const sqlFunctionArgumentLimit = 32;
export function sqlFunction(
  name: "json" | "json_set" | "json_insert" | "json_extract" | "json_array_length",
  args: string[],
): string {
  if (args.length > sqlFunctionArgumentLimit)
    throw new Error(
      `SQL function ${name} exceeds ${sqlFunctionArgumentLimit} arguments (${args.length})`,
    );
  return `${name}(${args.join(", ")})`;
}
function jsonValue(value: unknown): string {
  return sqlFunction("json", [sqlLiteral(JSON.stringify(value))]);
}
function replayField(name: string): string {
  return sqlFunction("json_extract", ["record_json", sqlLiteral(`$.replay.${name}`)]);
}
const replayStepsCount = sqlFunction("json_array_length", ["record_json", "'$.replay.steps'"]);
export function sqlLiteral(value: string): string {
  if (/[\r\n\0\u2028\u2029]/u.test(value))
    throw new Error("SQL literal contains a line break or NUL");
  return `'${value.replaceAll("'", "''")}'`;
}
export function sqlBytes(sql: string): number {
  return new TextEncoder().encode(sql).length;
}
function checkSize(sql: string, limit: number): string {
  const bytes = sqlBytes(sql + "\n");
  if (bytes > limit) throw new Error(`SQL statement exceeds ${limit} bytes (${bytes} bytes)`);
  return sql;
}

export function conversionSql(
  record: SnapshotMatch,
  encoded: ReturnType<typeof encodeSnapshotMatch>,
  limit: number,
): string[] {
  const id = sqlLiteral(record.id),
    game = sqlLiteral(record.settings.game);
  const old = `id = ${id} AND game = ${game} AND ${replayField("format")} IS NULL AND ${replayStepsCount} = ${record.replay.steps.length}`;
  const exists = `EXISTS (SELECT 1 FROM matches WHERE ${old})`;
  const statements = [`DELETE FROM match_event_chunks WHERE match_id = ${id} AND ${exists};`];
  const schema = matchEventSchema(record.settings.game);
  for (let start = 0; start < encoded.events.length; start += matchChunkSize) {
    const events = encoded.events.slice(start, start + matchChunkSize);
    const row = {
      chunk_index: start / matchChunkSize,
      start_index: start,
      event_count: events.length,
      events_json: JSON.stringify(events),
    };
    readMatchChunk(row, encoded.events.length, (event) => schema.parse(event));
    statements.push(
      `INSERT INTO match_event_chunks(match_id, chunk_index, start_index, event_count, events_json) SELECT ${id}, ${row.chunk_index}, ${start}, ${events.length}, ${sqlLiteral(row.events_json)} WHERE ${exists};`,
    );
  }
  const updated = sqlFunction("json_set", [
    "record_json",
    "'$.replay'",
    jsonValue(encoded.record.replay),
  ]);
  statements.push(`UPDATE matches SET record_json = ${updated} WHERE ${old};`);
  return statements.map((sql) => checkSize(sql, limit));
}

export function rollbackSql(
  record: SnapshotMatch,
  originalReplay: SnapshotMatch["replay"],
  limit: number,
): string[] {
  const id = sqlLiteral(record.id),
    game = sqlLiteral(record.settings.game);
  const count = record.replay.steps.length;
  const target = `id = ${id} AND game = ${game}`;
  const eventTarget = `${target} AND ${replayField("format")} = 'events' AND ${replayField("eventCount")} = ${count}`;
  // 対局IDはUUIDなので、この接頭辞の作業行は公開棋譜の読取りと衝突しません。
  const workId = sqlLiteral(`tb-106-rollback:${record.id}`);
  const workTarget = `match_id = ${workId} AND chunk_index = 0`;
  const workCount = sqlFunction("json_array_length", ["events_json"]);
  const statements = [
    `DELETE FROM match_event_chunks WHERE match_id = ${workId};`,
    `INSERT INTO match_event_chunks(match_id, chunk_index, start_index, event_count, events_json) SELECT ${workId}, 0, 0, 0, '[]' WHERE EXISTS (SELECT 1 FROM matches WHERE ${eventTarget});`,
  ];
  let start = 0;
  while (start < originalReplay.steps.length) {
    const next = appendStepsSql(
      originalReplay.steps,
      start,
      `${workTarget} AND ${workCount} = ${start} AND EXISTS (SELECT 1 FROM matches WHERE ${eventTarget})`,
      limit,
    );
    statements.push(next.sql);
    start = next.end;
  }
  const { steps: _steps, ...initial } = originalReplay;
  const steps = sqlFunction("json", [
    `(SELECT events_json FROM match_event_chunks WHERE ${workTarget})`,
  ]);
  const replay = sqlFunction("json_set", [jsonValue(initial), "'$.steps'", steps]);
  const updated = sqlFunction("json_set", ["record_json", "'$.replay'", replay]);
  statements.push(
    `UPDATE matches SET record_json = ${updated} WHERE ${eventTarget} AND EXISTS (SELECT 1 FROM match_event_chunks WHERE ${workTarget} AND event_count = ${count} AND ${workCount} = ${count});`,
    `DELETE FROM match_event_chunks WHERE match_id = ${workId};`,
    `DELETE FROM match_event_chunks WHERE match_id = ${id} AND EXISTS (SELECT 1 FROM matches WHERE ${target} AND ${replayField("format")} IS NULL AND ${replayStepsCount} = ${count});`,
  );
  return statements.map((sql) => checkSize(sql, limit));
}

function appendStepsSql(steps: unknown[], start: number, target: string, limit: number) {
  const args = ["events_json"];
  let sql = "",
    end = start;
  const stepLimit = Math.floor((sqlFunctionArgumentLimit - 1) / 2);
  for (; end < Math.min(start + stepLimit, steps.length); end++) {
    const nextArgs = [...args, "'$[#]'", jsonValue(steps[end])];
    const next = `UPDATE match_event_chunks SET events_json = ${sqlFunction("json_insert", nextArgs)}, event_count = ${end + 1} WHERE ${target};`;
    if (sqlBytes(next + "\n") > limit) break;
    args.push("'$[#]'", jsonValue(steps[end]));
    sql = next;
  }
  if (end === start)
    throw new Error(`Rollback step ${start} exceeds SQL statement limit ${limit} bytes`);
  return { sql, end };
}
