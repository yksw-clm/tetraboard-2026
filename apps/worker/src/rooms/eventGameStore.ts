import type { z } from "zod";
export type EventReplayPage<I, E> = {
  instanceId: string;
  roundId: string;
  rulesVersion: 1;
  initial: I;
  eventCount: number;
  events: { index: number; event: E }[];
  nextCursor: number | null;
};
/** SQLiteのイベント列・保護されたアーカイブは両将棋で共用する。テーブル名はコードで固定する。 */
export class EventGameStore<Initial, Event> {
  constructor(
    protected readonly sql: SqlStorage,
    protected readonly prefix: "shogi" | "standard_shogi",
    private readonly initialSchema: z.ZodType<Initial>,
    private readonly eventSchema: z.ZodType<Event>,
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${prefix}_repetitions (round_id TEXT NOT NULL, position_key TEXT NOT NULL, occurrences ${prefix === "shogi" ? "INTEGER" : "TEXT"} NOT NULL, PRIMARY KEY(round_id, position_key))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${prefix}_rounds (round_id TEXT PRIMARY KEY, initial_json TEXT NOT NULL, event_count INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${prefix}_events (round_id TEXT NOT NULL, event_index INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(round_id, event_index))`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS ${prefix}_archives (round_id TEXT PRIMARY KEY NOT NULL)`);
  }
  clear(): void {
    this.sql.exec(`DELETE FROM ${this.prefix}_repetitions`);
    this.sql.exec(
      `DELETE FROM ${this.prefix}_events WHERE round_id NOT IN (SELECT round_id FROM ${this.prefix}_archives)`,
    );
    this.sql.exec(
      `DELETE FROM ${this.prefix}_rounds WHERE round_id NOT IN (SELECT round_id FROM ${this.prefix}_archives)`,
    );
  }
  protectArchive(roundId: string): void {
    this.sql.exec(`INSERT INTO ${this.prefix}_archives VALUES (?) ON CONFLICT DO NOTHING`, roundId);
    this.sql.exec(`DELETE FROM ${this.prefix}_repetitions WHERE round_id = ?`, roundId);
  }
  releaseArchive(roundId: string, keepReplay: boolean): void {
    this.sql.exec(`DELETE FROM ${this.prefix}_archives WHERE round_id = ?`, roundId);
    if (keepReplay) return;
    this.sql.exec(`DELETE FROM ${this.prefix}_events WHERE round_id = ?`, roundId);
    this.sql.exec(`DELETE FROM ${this.prefix}_rounds WHERE round_id = ?`, roundId);
    this.sql.exec(`DELETE FROM ${this.prefix}_repetitions WHERE round_id = ?`, roundId);
  }
  replayInfo(roundId: string): Initial {
    const row = this.sql
      .exec<{ initial_json: string }>(
        `SELECT initial_json FROM ${this.prefix}_rounds WHERE round_id = ?`,
        roundId,
      )
      .one();
    return this.initialSchema.parse(JSON.parse(row.initial_json));
  }
  replayEvents(roundId: string, cursor: number): Event[] {
    const rows = this.sql
      .exec<{ event_index: number; event_json: string }>(
        `SELECT event_index, event_json FROM ${this.prefix}_events WHERE round_id = ? AND event_index >= ? ORDER BY event_index LIMIT 100`,
        roundId,
        cursor,
      )
      .toArray();
    if (rows.some((row, i) => row.event_index !== cursor + i))
      throw new Error("Shogi events are not contiguous");
    return rows.map((row) => this.eventSchema.parse(JSON.parse(row.event_json)));
  }
  startReplay(roundId: string, initial: Initial): void {
    this.clear();
    this.sql.exec(
      `INSERT INTO ${this.prefix}_rounds VALUES (?, ?, 0)`,
      roundId,
      JSON.stringify(this.initialSchema.parse(initial)),
    );
  }
  appendEvent(roundId: string, event: Event): void {
    const row = this.sql
      .exec<{ event_count: number }>(
        `SELECT event_count FROM ${this.prefix}_rounds WHERE round_id = ?`,
        roundId,
      )
      .one();
    this.sql.exec(
      `INSERT INTO ${this.prefix}_events VALUES (?, ?, ?)`,
      roundId,
      row.event_count,
      JSON.stringify(this.eventSchema.parse(event)),
    );
    this.sql.exec(
      `UPDATE ${this.prefix}_rounds SET event_count = event_count + 1 WHERE round_id = ?`,
      roundId,
    );
  }
  getPage(
    instanceId: string,
    roundId: string,
    cursor: number,
    throughEventCount?: number,
  ): EventReplayPage<Initial, Event> | null {
    const row = this.sql
      .exec<{ initial_json: string; event_count: number }>(
        `SELECT initial_json, event_count FROM ${this.prefix}_rounds WHERE round_id = ?`,
        roundId,
      )
      .toArray()[0];
    const eventCount = throughEventCount ?? row?.event_count;
    if (
      !row ||
      eventCount === undefined ||
      !Number.isSafeInteger(cursor) ||
      !Number.isSafeInteger(eventCount) ||
      cursor < 0 ||
      eventCount < cursor ||
      eventCount > row.event_count
    )
      return null;
    const events = this.sql
      .exec<{ event_index: number; event_json: string }>(
        `SELECT event_index, event_json FROM ${this.prefix}_events WHERE round_id = ? AND event_index >= ? AND event_index < ? ORDER BY event_index LIMIT 100`,
        roundId,
        cursor,
        eventCount,
      )
      .toArray()
      .map((row) => ({
        index: row.event_index,
        event: this.eventSchema.parse(JSON.parse(row.event_json)),
      }));
    return {
      instanceId,
      roundId,
      rulesVersion: 1,
      initial: this.initialSchema.parse(JSON.parse(row.initial_json)),
      eventCount,
      events,
      nextCursor: cursor + events.length < eventCount ? cursor + events.length : null,
    };
  }
  eventCount(roundId: string): number {
    return this.sql
      .exec<{ event_count: number }>(
        `SELECT event_count FROM ${this.prefix}_rounds WHERE round_id = ?`,
        roundId,
      )
      .one().event_count;
  }
}
