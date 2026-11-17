import type {
  RatingReader,
  RatingPublication,
  SkillRatingStore,
  RatingGame,
  SkillGame,
  EloGame,
  EloResultRow,
  SkillResultRow,
  LatestRating,
  RankingRow,
  PendingRating,
  CurrentSkill,
  SkillChange,
  SkillMatch,
  eloPolicy,
  TimeControl,
} from "../src";

export type Write = () => number;
export class MemoryRatings implements RatingReader, SkillRatingStore<Write> {
  latestRows = new Map<string, LatestRating>();
  beforeRow: { rating: number; rated_games: number } | null = null;
  eloRow: EloResultRow | null = null;
  skillRows: SkillResultRow[] = [];
  rankingRows: RankingRow[] = [];
  pending: (PendingRating & { accountId: string })[] = [];
  accounts = new Map<string, CurrentSkill>();
  saved = new Map<string, SkillChange[]>();
  conflicts = 0;
  saves = 0;
  async latest(game: RatingGame, id: string) {
    return this.latestRows.get(`${game}:${id}`) ?? null;
  }
  async pendingAccounts(ids: string[]) {
    return this.pending.filter((p) => ids.includes(p.accountId)).map((p) => p.accountId);
  }
  async before() {
    return this.beforeRow;
  }
  async eloResult() {
    return this.eloRow;
  }
  async skillResult() {
    return this.skillRows;
  }
  async rankings() {
    return this.rankingRows;
  }
  async previous(id: string, games: RatingGame[]) {
    return (
      games.flatMap((game) =>
        this.pending.filter((p) => p.game === game && p.accountId === id),
      )[0] ?? null
    );
  }
  async applied(game: SkillGame, id: string) {
    return this.saved.has(`${game}:${id}`);
  }
  async current(_game: SkillGame, ids: string[]) {
    return ids.flatMap((id) => (this.accounts.has(id) ? [{ ...this.accounts.get(id)! }] : []));
  }
  changes(game: SkillGame, id: string, changes: SkillChange[]): Write {
    return () => {
      this.saves++;
      if (this.conflicts-- > 0) return 0;
      if (
        this.saved.has(`${game}:${id}`) ||
        changes.some((c) => this.accounts.get(c.accountId)?.rated_games !== c.ratedGames - 1)
      )
        return 0;
      this.saved.set(`${game}:${id}`, changes);
      for (const c of changes)
        this.accounts.set(c.accountId, {
          account_id: c.accountId,
          mu: c.muAfter,
          sigma: c.sigmaAfter,
          rated_games: c.ratedGames,
          human_games: c.humanGames,
        });
      return changes.length;
    };
  }
  async save(write: Write) {
    return write();
  }
}

export class MemoryPublication implements RatingPublication<Write> {
  seats = new Map<string, string>();
  pending = new Map<string, string>();
  published = new Set<string>();
  events: string[] = [];
  policy?: typeof eloPolicy;
  clocks?: TimeControl[];
  eloChanges(game: EloGame, id: string, policy: typeof eloPolicy, clocks: TimeControl[]): Write {
    this.policy = policy;
    this.clocks = clocks;
    return () => {
      this.events.push(`update:${game}:${id}`);
      return 1;
    };
  }
  reserve(game: RatingGame, id: string, accountId: string, operationId: string): Write {
    return () => {
      const key = `${game}:${accountId}`;
      if (this.seats.get(accountId) !== operationId || this.pending.has(key)) return 0;
      this.pending.set(key, id);
      return 1;
    };
  }
  clearPending(game: RatingGame, id: string): Write {
    return () => {
      for (const [key, match] of this.pending)
        if (key.startsWith(`${game}:`) && match === id) this.pending.delete(key);
      return 1;
    };
  }
  clearPublishedPending(game: RatingGame, id: string): Write {
    return () => (this.published.has(`${game}:${id}`) ? this.clearPending(game, id)() : 0);
  }
  latest(): Write {
    return () => 0;
  }
}

export function skillMatch(humans = 1): SkillMatch {
  const seats = ["a", "b", "c", "d"];
  return {
    id: "match",
    settings: {
      mode: "singles",
      threePlayerAttackProhibited: true,
      timeControl: { mainTimeMs: 0, byoyomiMs: 30000 },
    },
    result: { mode: "singles", standings: seats.map((seat, i) => ({ seat, rank: i + 1 })) },
    participants: seats.map((seat, i) =>
      i < humans
        ? { kind: "human", seat, accountId: seat }
        : { kind: "cpu", seat, cpuProfile: { id: "cpu", hash: "hash" } },
    ),
    source: {
      cpu: Object.fromEntries(
        seats
          .slice(humans)
          .map((seat) => [seat, { mu: 25, sigma: 1, profileId: "cpu", profileHash: "hash" }]),
      ),
    },
  };
}
export function seed(store: MemoryRatings, count = 1, games = 0) {
  for (const account_id of ["a", "b", "c", "d"].slice(0, count))
    store.accounts.set(account_id, {
      account_id,
      mu: 25,
      sigma: 25 / 3,
      rated_games: games,
      human_games: 0,
    });
}
