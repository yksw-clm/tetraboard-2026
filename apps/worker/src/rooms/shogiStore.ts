import {
  fourShogiPublicStateSchema,
  fourShogiReplayEventSchema,
  type FourShogiPublicState,
  type FourShogiReplayEvent,
  type FourShogiReplayPage,
} from "@tetraboard/protocol";
import type { FourShogiState, InitialStateOptions } from "@tetraboard/four-shogi";

/** One position/event per SQLite row keeps room snapshots bounded as a game grows. */
export class ShogiStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS shogi_repetitions (round_id TEXT NOT NULL, position_key TEXT NOT NULL, occurrences INTEGER NOT NULL, PRIMARY KEY(round_id, position_key))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS shogi_rounds (round_id TEXT PRIMARY KEY, initial_json TEXT NOT NULL, event_count INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS shogi_events (round_id TEXT NOT NULL, event_index INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(round_id, event_index))`,
    );
  }
  clear(): void {
    this.sql.exec("DELETE FROM shogi_repetitions");
    this.sql.exec("DELETE FROM shogi_events");
    this.sql.exec("DELETE FROM shogi_rounds");
  }
  saveState(roundId: string, state: FourShogiState): FourShogiPublicState {
    // Engine state carries all counts; write only keys changed by this transition.
    const saved = new Map(
      this.sql
        .exec<{ position_key: string; occurrences: number }>(
          "SELECT position_key, occurrences FROM shogi_repetitions WHERE round_id = ?",
          roundId,
        )
        .toArray()
        .map((row) => [row.position_key, row.occurrences]),
    );
    for (const [key, count] of Object.entries(state.repetitions)) {
      if (saved.get(key) === count) continue;
      this.sql.exec(
        "INSERT INTO shogi_repetitions VALUES (?, ?, ?) ON CONFLICT(round_id, position_key) DO UPDATE SET occurrences = excluded.occurrences WHERE occurrences != excluded.occurrences",
        roundId,
        key,
        count,
      );
    }
    const { repetitions: _index, ...core } = state;
    return fourShogiPublicStateSchema.parse(core);
  }
  loadState(roundId: string, core: FourShogiPublicState): FourShogiState {
    const repetitions: Record<string, number> = {};
    for (const row of this.sql.exec<{ position_key: string; occurrences: number }>(
      "SELECT position_key, occurrences FROM shogi_repetitions WHERE round_id = ?",
      roundId,
    ))
      repetitions[row.position_key] = row.occurrences;
    return { ...core, repetitions } as FourShogiState;
  }
  startReplay(roundId: string, initial: InitialStateOptions): void {
    this.clear();
    this.sql.exec(
      "INSERT INTO shogi_rounds VALUES (?, ?, 0)",
      roundId,
      JSON.stringify({
        ...initial,
        threePlayerAttackProhibited: initial.threePlayerAttackProhibited ?? true,
      }),
    );
  }
  appendEvent(roundId: string, event: FourShogiReplayEvent): void {
    const row = this.sql
      .exec<{ event_count: number }>(
        "SELECT event_count FROM shogi_rounds WHERE round_id = ?",
        roundId,
      )
      .one();
    this.sql.exec(
      "INSERT INTO shogi_events VALUES (?, ?, ?)",
      roundId,
      row.event_count,
      JSON.stringify(fourShogiReplayEventSchema.parse(event)),
    );
    this.sql.exec(
      "UPDATE shogi_rounds SET event_count = event_count + 1 WHERE round_id = ?",
      roundId,
    );
  }
  getPage(instanceId: string, roundId: string, cursor: number): FourShogiReplayPage | null {
    const row = this.sql
      .exec<{ initial_json: string; event_count: number }>(
        "SELECT initial_json, event_count FROM shogi_rounds WHERE round_id = ?",
        roundId,
      )
      .toArray()[0];
    if (!row || cursor > row.event_count) return null;
    const events = this.sql
      .exec<{ event_index: number; event_json: string }>(
        "SELECT event_index, event_json FROM shogi_events WHERE round_id = ? AND event_index >= ? ORDER BY event_index LIMIT 100",
        roundId,
        cursor,
      )
      .toArray()
      .map((row) => ({
        index: row.event_index,
        event: fourShogiReplayEventSchema.parse(JSON.parse(row.event_json)),
      }));
    return {
      instanceId,
      roundId,
      rulesVersion: 1,
      initial: JSON.parse(row.initial_json),
      eventCount: row.event_count,
      events,
      nextCursor: cursor + events.length < row.event_count ? cursor + events.length : null,
    };
  }
  eventCount(roundId: string): number {
    return this.sql
      .exec<{ event_count: number }>(
        "SELECT event_count FROM shogi_rounds WHERE round_id = ?",
        roundId,
      )
      .one().event_count;
  }
}
