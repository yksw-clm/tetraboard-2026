import {
  shogiPublicStateSchema,
  shogiReplayInitialSchema,
  shogiReplayEventSchema,
  type ShogiPublicState,
  type ShogiReplayEvent,
  type ShogiReplayPage,
} from "@tetraboard/protocol";
import type { ShogiState, RepetitionLookup, RepetitionEntry } from "@tetraboard/shogi";
import { EventGameStore } from "./eventGameStore";
export class StandardShogiStore extends EventGameStore<
  ShogiReplayPage["initial"],
  ShogiReplayEvent
> {
  constructor(sql: SqlStorage) {
    super(sql, "standard_shogi", shogiReplayInitialSchema, shogiReplayEventSchema);
  }
  saveState(roundId: string, state: ShogiState): ShogiPublicState {
    for (const [key, entry] of Object.entries(state.repetitions))
      this.sql.exec(
        "INSERT INTO standard_shogi_repetitions VALUES (?, ?, ?) ON CONFLICT(round_id, position_key) DO UPDATE SET occurrences = excluded.occurrences",
        roundId,
        key,
        JSON.stringify(entry),
      );
    const { repetitions: _index, ...core } = state;
    return shogiPublicStateSchema.parse(core);
  }
  loadTransition(
    roundId: string,
    core: ShogiPublicState,
  ): { state: ShogiState; repetitionLookup: RepetitionLookup } {
    const cache = new Map<string, RepetitionEntry | undefined>();
    return {
      state: { ...core, repetitions: {} } as ShogiState,
      repetitionLookup: (key) => {
        if (cache.has(key)) return cache.get(key);
        const row = this.sql
          .exec<{ occurrences: string }>(
            "SELECT occurrences FROM standard_shogi_repetitions WHERE round_id = ? AND position_key = ?",
            roundId,
            key,
          )
          .toArray()[0];
        const value: RepetitionEntry | undefined = row ? JSON.parse(row.occurrences) : undefined;
        cache.set(key, value);
        return value;
      },
    };
  }
}
