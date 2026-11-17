import type { GameId, MatchKind } from "@tetraboard/protocol";
import type { MatchReadStore, MatchRow, ChunkRow, HistoryQuery, StoredMatch } from "../src";

export class MemoryReadStore implements MatchReadStore {
  records: StoredMatch[] = [];
  history = new Map<string, Set<string>>();
  chunks = new Map<string, ChunkRow[]>();
  kinds = new Map<string, MatchKind>();
  calls: string[] = [];
  private row(match: StoredMatch): MatchRow {
    return { game: match.game, record_json: JSON.stringify(match.record) };
  }
  async readMatch(id: string, accountId?: string) {
    this.calls.push("match");
    const match = this.records.find(
      ({ record }) =>
        record.id === id && (accountId === undefined || this.history.get(accountId)?.has(id)),
    );
    return match ? this.row(match) : null;
  }
  private sorted(records: StoredMatch[]) {
    return records.toSorted(
      (a, b) =>
        b.record.startedAtMs - a.record.startedAtMs || b.record.id.localeCompare(a.record.id),
    );
  }
  async readHistory(query: HistoryQuery) {
    this.calls.push(`history:${query.filter}`);
    return this.sorted(
      this.records.filter(({ game, record }) => {
        const kind = this.kinds.get(record.id) ?? "normal";
        const cpu = record.participants.some((p) => p.kind === "cpu");
        return (
          this.history.get(query.accountId)?.has(record.id) &&
          game === query.game &&
          ("mode" in record.settings ? record.settings.mode : "standard") ===
            (query.mode ?? "standard") &&
          (!query.cursor ||
            record.startedAtMs < query.cursor.startedAtMs ||
            (record.startedAtMs === query.cursor.startedAtMs && record.id < query.cursor.id)) &&
          (query.filter === "all" ||
            (query.filter === "rated"
              ? kind === "rated"
              : (kind === "normal" || kind === "tournament") && cpu === (query.filter === "cpu")))
        );
      }),
    )
      .slice(0, 21)
      .map((record) => this.row(record));
  }
  async readPublic(game: GameId | undefined, humanOnly: boolean) {
    this.calls.push(`public:${game}:${humanOnly}`);
    return this.sorted(
      this.records.filter(
        (record) =>
          (!game || record.game === game) &&
          (!humanOnly || record.record.participants.every((p) => p.kind === "human")),
      ),
    )
      .slice(0, 20)
      .map((record) => this.row(record));
  }
  async readKinds(ids: string[]) {
    this.calls.push(`kinds:${ids.length}`);
    return this.kinds;
  }
  async readDetailChunks(id: string) {
    this.calls.push("chunks");
    return this.chunks.get(id) ?? [];
  }
  async readReplayRecord(id: string, game: "shogi" | "four-shogi") {
    this.calls.push("replay");
    const match = this.records.find((m) => m.record.id === id && m.game === game);
    return match ? JSON.stringify(match.record) : null;
  }
  async readReplayChunks(id: string, first: number, last: number) {
    this.calls.push(`replayChunks:${first}:${last}`);
    return (this.chunks.get(id) ?? []).filter(
      (row) => row.chunk_index >= first && row.chunk_index <= last,
    );
  }
}
