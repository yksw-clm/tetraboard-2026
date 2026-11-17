import type {
  TournamentReader,
  TournamentRow,
  ScoreRow,
  TournamentFinalization,
  FinalizationGuard,
  InternalStanding,
  TournamentEntryStore,
  TournamentDraftStore,
} from "../src";
import type { TournamentInput } from "@tetraboard/protocol";
import { row } from "./fixtures";
export type Write = () => void;
export class MemoryTournaments
  implements TournamentReader, TournamentEntryStore, TournamentDraftStore
{
  tournament: TournamentRow | null = row();
  scores: ScoreRow[] = [];
  entries = new Map<string, string>();
  validAccounts = new Set(["account"]);
  async read() {
    return this.tournament;
  }
  async public() {
    return this.tournament?.published ? this.tournament : null;
  }
  async entryCount() {
    return this.entries.size;
  }
  async counts() {
    return { playing: 0, pending: 0, completed: 0 };
  }
  async waitingCount() {
    return 0;
  }
  async lobbyRows() {
    return this.tournament
      ? [
          {
            ...this.tournament,
            entryCount: this.entries.size,
            waitingCount: 0,
            playingCount: 0,
            pendingCount: 0,
            completedCount: 0,
          },
        ]
      : [];
  }
  async listRows() {
    return this.tournament ? [{ ...this.tournament, entryCount: this.entries.size }] : [];
  }
  async winnerRows() {
    return this.scores
      .filter((s) => s.finalRank === 1 && s.games > 0)
      .map((s) => ({ ...s, tournamentKey: "tournament" }));
  }
  async scoreRows() {
    return this.scores;
  }
  async adminRows() {
    return this.tournament ? [this.tournament] : [];
  }
  async eligible(accountId: string) {
    const entryId = this.entries.get(accountId);
    return this.validAccounts.has(accountId) && entryId
      ? { id: accountId, name: "本人", avatarKey: null, avatarPresetId: null, entryId }
      : null;
  }
  async insert(_key: string, accountId: string, id: string) {
    if (this.validAccounts.has(accountId) && !this.entries.has(accountId))
      this.entries.set(accountId, id);
  }
  async create(input: TournamentInput, key: string, now: number) {
    this.tournament = row({
      key,
      public_id: null,
      published: 0,
      name: input.name,
      description: input.description,
      rules_description: input.rulesDescription,
      starts_at_ms: input.startsAtMs,
      ends_at_ms: input.endsAtMs,
      rule_version: 2,
      game: input.settings.game,
      settings_json: JSON.stringify(input.settings),
      created_at_ms: now,
      updated_at_ms: now,
    });
  }
  async update(_key: string, input: TournamentInput, version: number, now: number) {
    if (!this.tournament || this.tournament.version !== version) return false;
    Object.assign(this.tournament, { name: input.name, version: version + 1, updated_at_ms: now });
    return true;
  }
}
export class MemoryFinalization implements TournamentFinalization<Write> {
  unresolved = false;
  notifications: unknown[] = [];
  events: string[] = [];
  beforeBatch?: () => void;
  constructor(private store: MemoryTournaments) {}
  async pending() {
    return this.unresolved;
  }
  private guarded(guard: FinalizationGuard, run: () => void): Write {
    return () => {
      if (
        !this.unresolved &&
        this.store.tournament?.finalized_at_ms === null &&
        this.store.scores.length === guard.entries
      )
        run();
    };
  }
  rank(standing: InternalStanding, guard: FinalizationGuard) {
    return this.guarded(guard, () => {
      this.events.push(`rank:${standing.entryId}`);
      this.store.scores.find((s) => s.entryId === standing.entryId)!.finalRank = standing.rank;
    });
  }
  notification(
    standing: InternalStanding,
    payload: unknown,
    _now: number,
    guard: FinalizationGuard,
  ) {
    return this.guarded(guard, () => {
      this.events.push(`notification:${standing.entryId}`);
      this.notifications.push(payload);
    });
  }
  finish(_key: string, now: number, guard: FinalizationGuard) {
    return this.guarded(guard, () => {
      this.events.push("finish");
      this.store.tournament!.finalized_at_ms = now;
    });
  }
  async batch(writes: Write[]) {
    this.beforeBatch?.();
    writes.forEach((write) => write());
  }
}
