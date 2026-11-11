import type { MatchmakingGame } from "@tetraboard/protocol";

type SequenceScope = `rated:${MatchmakingGame}` | `tournament:${string}`;

export async function reserveMatchSequence(
  db: D1Database,
  matchId: string,
  scope: SequenceScope,
): Promise<number> {
  // MAXの参照と追加を一文で確定し、同じ対局の再試行では既存の番号を保持します。
  await db
    .prepare(`INSERT INTO room_match_sequences(match_id, scope, sequence)
    SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1 FROM room_match_sequences WHERE scope=?
    ON CONFLICT(match_id) DO NOTHING`)
    .bind(matchId, scope, scope)
    .run();
  const row = await db
    .prepare("SELECT scope, sequence FROM room_match_sequences WHERE match_id=?")
    .bind(matchId)
    .first<{ scope: string; sequence: number }>();
  if (!row || row.scope !== scope || !Number.isSafeInteger(row.sequence) || row.sequence < 1)
    throw new Error("Invalid match sequence reservation");
  return row.sequence;
}
