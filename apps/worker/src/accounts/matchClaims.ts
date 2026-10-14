import { badgeAwardStatements } from "./badgeAwards";
import { readStoredMatch, type DecodedMatch } from "./matchDataContracts";
import { isDeleted, redactParticipants } from "../privacy/identity";

export type MatchClaimInput = {
  matchId: string;
  playerId: string;
  accountId: string;
  roomId: string;
  instanceId: string;
};
export type MatchClaimState = "pending" | "applied" | "retired" | "rejected";
export type MatchClaimGuard = { registrationId: string; sessionId: string };
type ClaimRow = {
  match_id: string;
  player_id: string;
  account_id: string | null;
  room_id: string;
  instance_id: string;
  state: MatchClaimState;
};
export class MatchClaimError extends Error {
  constructor(public readonly code: "conflict" | "ineligible" | "retired") {
    super(`Match claim ${code}`);
  }
}

async function storedMatch(db: D1Database, matchId: string) {
  const row = await db
    .prepare("SELECT game,record_json FROM matches WHERE id=?")
    .bind(matchId)
    .first<{ game: string; record_json: string }>();
  return row ? readStoredMatch(row.record_json, row.game) : null;
}

function validateParticipant(record: DecodedMatch, input: MatchClaimInput) {
  const data = record.record;
  const player = data.participants.find((p) => p.id === input.playerId);
  if (
    data.id !== input.matchId ||
    data.roomId !== input.roomId ||
    data.instanceId !== input.instanceId ||
    !player ||
    player.kind !== "human" ||
    player.accountId !== null ||
    player.retired
  )
    throw new MatchClaimError("ineligible");
  if (data.participants.some((p) => p.kind === "human" && p.accountId === input.accountId))
    throw new MatchClaimError("conflict");
}

export async function readMatchClaimState(
  db: D1Database,
  matchId: string,
  playerId: string,
  accountId: string,
): Promise<MatchClaimState | null> {
  const row = await db
    .prepare(
      "SELECT state,account_id FROM match_participant_accounts WHERE match_id=? AND player_id=?",
    )
    .bind(matchId, playerId)
    .first<Pick<ClaimRow, "state" | "account_id">>();
  return row?.state === "retired" || row?.state === "rejected"
    ? row.state
    : row?.account_id === accountId
      ? row.state
      : null;
}

/** ゲスト本人の資格をサーバーで検証した後だけ呼び、保存待ちでも受付を永続化します。 */
export async function acceptMatchClaim(
  db: D1Database,
  input: MatchClaimInput,
  guard?: MatchClaimGuard,
): Promise<"pending" | "applied"> {
  if (await isDeleted(db, input.accountId)) throw new MatchClaimError("retired");
  const previous = await readMatchClaimState(db, input.matchId, input.playerId, input.accountId);
  if (previous === "retired") throw new MatchClaimError("retired");
  if (previous === "rejected") throw new MatchClaimError("conflict");
  const record = await storedMatch(db, input.matchId);
  if (record) validateParticipant(record, input);
  const now = Date.now();
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      SELECT ?,?,id,?,?,'pending',?,? FROM user WHERE id=? AND profileCompleted=1
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id)
        ${
          guard
            ? `AND EXISTS(SELECT 1 FROM registration_flows f JOIN session s ON s.id=f.session_id AND s.userId=f.account_id
          WHERE f.id=? AND f.session_id=? AND f.account_id=user.id AND f.cancelled_at_ms IS NULL
          AND f.claim_until_ms>? AND s.expiresAt>?)`
            : ""
        }`)
      .bind(
        input.matchId,
        input.playerId,
        input.roomId,
        input.instanceId,
        now,
        now,
        input.accountId,
        ...(guard ? [guard.registrationId, guard.sessionId, now, now] : []),
      ),
    db
      .prepare(`INSERT OR IGNORE INTO privacy_room_accounts(account_id,room_id)
      SELECT account_id,room_id FROM match_participant_accounts WHERE match_id=? AND player_id=? AND account_id=?`)
      .bind(input.matchId, input.playerId, input.accountId),
  ]);
  const row = await db
    .prepare("SELECT * FROM match_participant_accounts WHERE match_id=? AND player_id=?")
    .bind(input.matchId, input.playerId)
    .first<ClaimRow>();
  if (row?.state === "retired" || (await isDeleted(db, input.accountId)))
    throw new MatchClaimError("retired");
  if (row?.state === "rejected") throw new MatchClaimError("conflict");
  if (
    !row ||
    row.account_id !== input.accountId ||
    row.room_id !== input.roomId ||
    row.instance_id !== input.instanceId
  )
    throw new MatchClaimError("conflict");
  try {
    await applyMatchClaims(db, input.matchId);
  } catch (error) {
    if (error instanceof MatchClaimError) throw error;
    // 受付は確定済みなので、一時的な保存障害は独立した再試行へ残します。
    console.error("Accepted match claim will be retried");
  }
  const state = await readMatchClaimState(db, input.matchId, input.playerId, input.accountId);
  if (state === "retired") throw new MatchClaimError("retired");
  if (state === "rejected") throw new MatchClaimError("conflict");
  if (!state) throw new MatchClaimError("conflict");
  return state;
}

/** 公開済みの棋譜を正本として、本人索引・獲得通知と紐付けを同時に確定します。 */
export async function applyMatchClaims(db: D1Database, matchId: string): Promise<void> {
  const rows = await db
    .prepare("SELECT * FROM match_participant_accounts WHERE match_id=? AND state='pending'")
    .bind(matchId)
    .all<ClaimRow>();
  if (!rows.results.length) return;
  const record = await storedMatch(db, matchId);
  if (!record) return;
  const transitions: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    let valid = true;
    try {
      if (!row.account_id) throw new MatchClaimError("ineligible");
      validateParticipant(record, {
        matchId,
        playerId: row.player_id,
        accountId: row.account_id,
        roomId: row.room_id,
        instanceId: row.instance_id,
      });
    } catch (error) {
      if (!(error instanceof MatchClaimError)) throw error;
      valid = false;
    }
    // 保存前に受け付けた不適格な1件で、他の本人索引や棋譜保存を停止しません。
    transitions.push(
      db
        .prepare(`UPDATE match_participant_accounts SET state='${valid ? "applied" : "rejected"}'${valid ? "" : ",account_id=NULL"}
      WHERE match_id=? AND player_id=? AND account_id=? AND room_id=? AND instance_id=? AND state='pending'
        AND EXISTS(SELECT 1 FROM user u WHERE u.id=account_id AND u.profileCompleted=1)
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=account_id)`)
        .bind(matchId, row.player_id, row.account_id, row.room_id, row.instance_id),
    );
  }
  await db.batch([
    ...transitions,
    db
      .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
      SELECT c.account_id,m.id,m.mode,m.started_at_ms,m.game
      FROM match_participant_accounts c JOIN matches m ON m.id=c.match_id
      WHERE c.match_id=? AND c.state='applied'
      ON CONFLICT(account_id,match_id) DO NOTHING`)
      .bind(matchId),
    ...badgeAwardStatements(db, record.game, matchId),
  ]);
}

/** 部屋閉鎖・再利用から独立して、確定前の引継ぎを少量ずつ回収します。 */
export async function retryPendingMatchClaims(db: D1Database, roomId?: string): Promise<void> {
  const rows = await db
    .prepare(`SELECT match_id FROM match_participant_accounts
    WHERE state='pending' AND retry_at_ms<=? ${roomId ? "AND room_id=?" : ""}
    GROUP BY match_id ORDER BY MIN(retry_at_ms),MIN(accepted_at_ms) LIMIT 25`)
    .bind(Date.now(), ...(roomId ? [roomId] : []))
    .all<{ match_id: string }>();
  for (const row of rows.results) {
    await db
      .prepare(
        "UPDATE match_participant_accounts SET retry_at_ms=? WHERE match_id=? AND state='pending'",
      )
      .bind(Date.now() + 5_000, row.match_id)
      .run();
    try {
      await applyMatchClaims(db, row.match_id);
    } catch {
      console.error("Pending match claim will be retried");
    }
  }
}

/** 保存済みJSONは変えず、読取り用の本人関係と退会状態だけを重ねます。 */
export async function resolveMatchParticipants(
  db: D1Database,
  record: DecodedMatch,
): Promise<void> {
  const rows = await db
    .prepare(
      "SELECT player_id,account_id FROM match_participant_accounts WHERE match_id=? AND state='applied'",
    )
    .bind(record.record.id)
    .all<Pick<ClaimRow, "player_id" | "account_id">>();
  const claims = new Map(rows.results.map((row) => [row.player_id, row.account_id]));
  record.record = {
    ...record.record,
    participants: record.record.participants.map((player) => {
      if (player.kind !== "human" || player.retired || !claims.has(player.id)) return player;
      const claimedId = claims.get(player.id)!;
      if (player.accountId !== null && player.accountId !== claimedId)
        throw new Error("Conflicting match participant identity");
      return { ...player, accountId: claimedId };
    }),
  } as DecodedMatch["record"];
  record.record = await redactParticipants(db, record.record);
}
