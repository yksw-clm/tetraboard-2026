import {
  fourShogiPublicStateSchema,
  fourShogiReplayInitialSchema,
  fourShogiReplayEventSchema,
  type FourShogiPublicState,
  type FourShogiReplayEvent,
  type FourShogiReplayPage,
} from "@tetraboard/protocol";
import type { FourShogiState, InitialStateOptions, RepetitionLookup } from "@tetraboard/four-shogi";
import { EventGameStore } from "./eventGameStore";
export class ShogiStore extends EventGameStore<
  FourShogiReplayPage["initial"],
  FourShogiReplayEvent
> {
  constructor(sql: SqlStorage) {
    super(sql, "shogi", fourShogiReplayInitialSchema, fourShogiReplayEventSchema);
  }
  override startReplay(roundId: string, initial: InitialStateOptions): void {
    super.startReplay(roundId, {
      ...initial,
      threePlayerAttackProhibited: initial.threePlayerAttackProhibited ?? true,
    });
  }
  saveState(roundId: string, state: FourShogiState): FourShogiPublicState {
    // Transition states contain only changed counts; full states remain supported for fixtures.
    for (const [key, count] of Object.entries(state.repetitions)) {
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
  /** One reader per synchronous transition: its cache must never outlive a commit/rollback. */
  loadTransition(
    roundId: string,
    core: FourShogiPublicState,
  ): {
    state: FourShogiState;
    repetitionLookup: RepetitionLookup;
  } {
    const counts = new Map<string, number>();
    return {
      state: { ...core, repetitions: {} } as FourShogiState,
      repetitionLookup: (key) => {
        const cached = counts.get(key);
        if (cached !== undefined) return cached;
        const row = this.sql
          .exec<{ occurrences: number }>(
            "SELECT occurrences FROM shogi_repetitions WHERE round_id = ? AND position_key = ?",
            roundId,
            key,
          )
          .toArray()[0];
        const count = row?.occurrences ?? 0;
        counts.set(key, count);
        return count;
      },
    };
  }
  /** Full materialization for offline inspection and storage fixtures, not live transitions. */
  loadState(roundId: string, core: FourShogiPublicState): FourShogiState {
    const repetitions: Record<string, number> = {};
    for (const row of this.sql.exec<{ position_key: string; occurrences: number }>(
      "SELECT position_key, occurrences FROM shogi_repetitions WHERE round_id = ?",
      roundId,
    ))
      repetitions[row.position_key] = row.occurrences;
    return { ...core, repetitions } as FourShogiState;
  }
}
