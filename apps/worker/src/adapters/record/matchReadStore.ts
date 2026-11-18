import type { ChunkRow, MatchReadStore, MatchRow, HistoryQuery } from "@tetraboard/context-record";
import type { GameId } from "@tetraboard/protocol";
import { gameCapacity } from "@tetraboard/protocol/games";
import { matchHistoryFilterSql, readMatchKinds } from "./matchKinds";
import { lobbyMatchesQuery } from "./lobbyMatchesQuery";

export class D1MatchReadStore implements MatchReadStore {
  constructor(private readonly db: D1Database) {}
  async readMatch(matchId: string, accountId?: string) {
    return accountId === undefined
      ? this.db
          .prepare("SELECT game, record_json FROM matches WHERE id = ?")
          .bind(matchId)
          .first<MatchRow>()
      : this.db
          .prepare(`SELECT m.game, m.record_json FROM account_match_history h
      JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.match_id = ?`)
          .bind(accountId, matchId)
          .first<MatchRow>();
  }
  async readHistory({ accountId, game, mode, cursor, filter }: HistoryQuery) {
    const sql = `SELECT m.game, m.record_json FROM account_match_history h
    JOIN matches m ON m.id = h.match_id WHERE h.account_id = ? AND h.game = ? AND m.game = h.game AND h.mode = ?${matchHistoryFilterSql(filter)}`;
    const statement = cursor
      ? this.db
          .prepare(`${sql} AND (h.started_at_ms < ? OR (h.started_at_ms = ? AND h.match_id < ?))
      ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
          .bind(
            accountId,
            game,
            mode ?? "standard",
            cursor.startedAtMs,
            cursor.startedAtMs,
            cursor.id,
          )
      : this.db
          .prepare(`${sql} ORDER BY h.started_at_ms DESC, h.match_id DESC LIMIT 21`)
          .bind(accountId, game, mode ?? "standard");
    return (await statement.all<MatchRow>()).results;
  }
  async readPublic(game: GameId | undefined, humanOnly: boolean) {
    return game === undefined ? this.readLobby(humanOnly) : this.readGamePublic(game, humanOnly);
  }
  private async readGamePublic(game: GameId, humanOnly: boolean) {
    const humanFilter = humanOnly
      ? `AND json_array_length(record_json, '$.participants') = ${gameCapacity(game)}
         AND NOT EXISTS (
           SELECT 1 FROM json_each(record_json, '$.participants') participant
           WHERE json_extract(participant.value, '$.kind') IS NOT 'human'
         )`
      : "";
    const rows = await this.db
      .prepare(`SELECT game, record_json FROM matches
      WHERE game = ? ${humanFilter} ORDER BY started_at_ms DESC, id DESC LIMIT 20`)
      .bind(game)
      .all<MatchRow>();
    return rows.results;
  }
  private async readLobby(humanOnly: boolean) {
    const rows = await this.db.prepare(lobbyMatchesQuery(humanOnly)).all<MatchRow>();
    return rows.results;
  }
  readKinds(matchIds: string[]) {
    return readMatchKinds(this.db, matchIds);
  }
  async readDetailChunks(matchId: string) {
    const rows = await this.db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM match_event_chunks WHERE match_id = ? ORDER BY chunk_index`)
      .bind(matchId)
      .all<ChunkRow>();
    return rows.results;
  }
  async readReplayRecord(matchId: string, game: "shogi" | "four-shogi") {
    const row = await this.db
      .prepare("SELECT record_json FROM matches WHERE id = ? AND game = ?")
      .bind(matchId, game)
      .first<{ record_json: string }>();
    return row?.record_json ?? null;
  }
  async readReplayChunks(matchId: string, first: number, last: number) {
    const rows = await this.db
      .prepare(`SELECT chunk_index, start_index, event_count, events_json
      FROM match_event_chunks WHERE match_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index`)
      .bind(matchId, first, last)
      .all<ChunkRow>();
    return rows.results;
  }
}
