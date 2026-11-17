import { matchChunkSize } from "@tetraboard/context-record";
import { readMatchRecord } from "../src/accounts/matchDataContracts";
import { encodeSnapshotMatch } from "../src/rooms/snapshotMatchEvents";
import type { MatchRecord } from "../src/rooms/matchStore";
import type { ShogiMatchRecord, StandardShogiMatchRecord } from "../src/rooms/shogiMatchStore";
import type { ShogiFormationUsage } from "../src/rooms/shogiFormationUsage";
import type { FourShogiReplayEvent, ShogiReplayEvent } from "@tetraboard/protocol";

type Fixture = {
  record: MatchRecord | ShogiMatchRecord | StandardShogiMatchRecord;
  events?: readonly (FourShogiReplayEvent | ShogiReplayEvent)[];
  usage?: ShogiFormationUsage;
};

// 読み取り・集計テストの過去局を直接用意し、保存処理自体は対象の局で検証します。
export async function seedStoredMatches(db: D1Database, fixtures: readonly Fixture[]) {
  const statements = fixtures.flatMap(({ record, events = [], usage }) => {
    const parsed = readMatchRecord(JSON.stringify(record), record.settings.game);
    const encoded =
      parsed.game === "four-shogi" || parsed.game === "shogi"
        ? { record: parsed.record, events }
        : encodeSnapshotMatch(parsed.record);
    const mode = "mode" in record.settings ? record.settings.mode : "standard";
    const rows = [
      db
        .prepare(`INSERT INTO matches
      (id, game, mode, started_at_ms, ended_at_ms, record_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          record.id,
          record.settings.game,
          mode,
          record.startedAtMs,
          record.endedAtMs,
          JSON.stringify(encoded.record),
        ),
    ];
    for (let cursor = 0; cursor < encoded.events.length; cursor += matchChunkSize) {
      const chunk = encoded.events.slice(cursor, cursor + matchChunkSize);
      rows.push(
        db
          .prepare("INSERT INTO match_event_chunks VALUES (?, ?, ?, ?, ?)")
          .bind(record.id, cursor / matchChunkSize, cursor, chunk.length, JSON.stringify(chunk)),
      );
    }
    for (const participant of record.participants) {
      if (participant.kind !== "human" || !participant.accountId) continue;
      rows.push(
        db
          .prepare(`INSERT INTO account_match_history
        (account_id, match_id, mode, started_at_ms, game) VALUES (?, ?, ?, ?, ?)`)
          .bind(participant.accountId, record.id, mode, record.startedAtMs, record.settings.game),
      );
    }
    if (usage)
      rows.push(
        db
          .prepare(`INSERT INTO four_shogi_formation_usages
      (match_id, analyzer_id, analysis_version, rules_version, used_by_side_json)
      VALUES (?, ?, ?, ?, ?)`)
          .bind(
            record.id,
            usage.analyzerId,
            usage.analysisVersion,
            usage.rulesVersion,
            JSON.stringify(usage.bySide),
          ),
      );
    return rows;
  });
  // 大量fixtureでも1回のリクエストへ無制限に詰め込みません。
  for (let start = 0; start < statements.length; start += 80)
    await db.batch(statements.slice(start, start + 80));
}
