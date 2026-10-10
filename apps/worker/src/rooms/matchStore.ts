import type { MatchRecord as ReversiMatchRecord } from "./reversiMatchStore";
import { badgeAwardStatements } from "../accounts/badgeAwards";
import {
  type FourReversiRoom as Room,
  type RoundReplay,
  type FourReversiMatchDetail,
} from "@tetraboard/protocol";

import { type FourReversiState } from "@tetraboard/four-reversi";

export type MatchParticipant = {
  id: string;
  name: string;
  color: NonNullable<Room["players"][number]["color"]>;
  seat: number;
} & ({ kind: "human"; accountId: string | null } | { kind: "cpu"; level: 1 | 2 });

export type MatchStart = {
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourReversiMatchDetail["settings"];
  participants: MatchParticipant[];
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<FourReversiState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: RoundReplay;
};
export type PendingMatch = { record: MatchRecord; retryAtMs: number };
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";

export async function writeMatch(
  db: D1Database,
  record: MatchRecord | ReversiMatchRecord,
): Promise<void> {
  const statements = [
    db
      .prepare(`INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(
        record.id,
        record.settings.game,
        record.settings.mode ?? "standard",
        record.startedAtMs,
        record.endedAtMs,
        JSON.stringify(record),
      ),
  ];
  // Index identities from the committed record, even if a conflicting retry arrives.
  statements.push(
    db
      .prepare(`INSERT INTO account_match_history
    (account_id, match_id, mode, started_at_ms, game)
    SELECT json_extract(p.value, '$.accountId'), m.id, m.mode, m.started_at_ms, m.game
    FROM matches m, json_each(m.record_json, '$.participants') p
    WHERE m.id = ? AND json_extract(p.value, '$.kind') = 'human'
      AND json_extract(p.value, '$.accountId') IS NOT NULL
    ON CONFLICT(account_id, match_id) DO NOTHING`)
      .bind(record.id),
  );
  statements.push(...badgeAwardStatements(db, record.settings.game, record.id));
  await db.batch(statements);
}
