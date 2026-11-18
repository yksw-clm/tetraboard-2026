import type { ReadableRecordMatch } from "../domain/matchData";
import type { MatchRow } from "./readPorts";
export type MatchClaimInput = {
  matchId: string;
  playerId: string;
  accountId: string;
  roomId: string;
  instanceId: string;
};
export type MatchClaimState = "pending" | "applied" | "retired" | "rejected";
export type MatchClaimGuard = { registrationId: string; sessionId: string };
export type ClaimRow = {
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

export interface MatchClaimReadStore {
  isDeleted(accountId: string): Promise<boolean>;
  readState(
    matchId: string,
    playerId: string,
  ): Promise<Pick<ClaimRow, "state" | "account_id"> | null>;
  readSaved(matchId: string): Promise<MatchRow | null>;
  readPending(matchId: string): Promise<ClaimRow[]>;
}
export function validateMatchClaimParticipant(record: ReadableRecordMatch, input: MatchClaimInput) {
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

export async function readClaimState(
  store: MatchClaimReadStore,
  matchId: string,
  playerId: string,
  accountId: string,
): Promise<MatchClaimState | null> {
  const row = await store.readState(matchId, playerId);
  return row?.state === "retired" || row?.state === "rejected"
    ? row.state
    : row?.account_id === accountId
      ? row.state
      : null;
}
export async function checkMatchClaim<D extends ReadableRecordMatch>(
  store: MatchClaimReadStore,
  input: MatchClaimInput,
  decode: (json: string, game: string) => D,
) {
  if (await store.isDeleted(input.accountId)) throw new MatchClaimError("retired");
  const previous = await readClaimState(store, input.matchId, input.playerId, input.accountId);
  if (previous === "retired") throw new MatchClaimError("retired");
  if (previous === "rejected") throw new MatchClaimError("conflict");
  const row = await store.readSaved(input.matchId);
  if (row) validateMatchClaimParticipant(decode(row.record_json, row.game), input);
}
export async function prepareMatchClaimTransitions<D extends ReadableRecordMatch>(
  store: MatchClaimReadStore,
  matchId: string,
  decode: (json: string, game: string) => D,
) {
  const rows = await store.readPending(matchId);
  if (!rows.length) return null;
  const saved = await store.readSaved(matchId);
  if (!saved) return null;
  const record = decode(saved.record_json, saved.game);
  const transitions = rows.map((row) => {
    let valid = true;
    try {
      if (!row.account_id) throw new MatchClaimError("ineligible");
      validateMatchClaimParticipant(record, {
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
    return { row, valid };
  });
  return { record, transitions };
}

export interface MatchClaimStore<Write> extends MatchClaimReadStore {
  accept(input: MatchClaimInput, now: number, guard?: MatchClaimGuard): Promise<void>;
  readAccepted(matchId: string, playerId: string): Promise<ClaimRow | null>;
  transition(matchId: string, row: ClaimRow, valid: boolean): Write;
  history(matchId: string): Write;
  badges(game: string, matchId: string): Write[];
  save(writes: Write[]): Promise<void>;
  findPendingRetries(now: number, roomId?: string): Promise<string[]>;
  postponeRetry(matchId: string, retryAt: number): Promise<void>;
}

type DecodeMatch = (json: string, game: string) => ReadableRecordMatch;
type ClaimRuntime = { now(): number; reportRetry(message: string): void };

/** ゲスト本人の資格を検証した後だけ呼び、保存待ちでも受付を永続化します。 */
export async function acceptMatchClaim<Write>(
  store: MatchClaimStore<Write>,
  input: MatchClaimInput,
  decode: DecodeMatch,
  runtime: ClaimRuntime,
  guard?: MatchClaimGuard,
): Promise<"pending" | "applied"> {
  await checkMatchClaim(store, input, decode);
  await store.accept(input, runtime.now(), guard);

  const row = await store.readAccepted(input.matchId, input.playerId);
  if (row?.state === "retired" || (await store.isDeleted(input.accountId)))
    throw new MatchClaimError("retired");
  if (
    !row ||
    row.state === "rejected" ||
    row.account_id !== input.accountId ||
    row.room_id !== input.roomId ||
    row.instance_id !== input.instanceId
  )
    throw new MatchClaimError("conflict");
  try {
    await applyMatchClaims(store, input.matchId, decode);
  } catch (error) {
    if (error instanceof MatchClaimError) throw error;
    // 受付は確定済みなので、一時的な保存障害は独立した再試行へ残します。
    runtime.reportRetry("Accepted match claim will be retried");
  }

  const state = await readClaimState(store, input.matchId, input.playerId, input.accountId);
  if (state === "retired") throw new MatchClaimError("retired");
  if (!state || state === "rejected") throw new MatchClaimError("conflict");
  return state;
}

/** 公開済みの棋譜を正本として、本人索引・獲得通知と紐付けを同時に確定します。 */
export async function applyMatchClaims<Write>(
  store: MatchClaimStore<Write>,
  matchId: string,
  decode: DecodeMatch,
): Promise<void> {
  const prepared = await prepareMatchClaimTransitions(store, matchId, decode);
  if (!prepared) return;
  // 保存前に受け付けた不適格な1件で、他の本人索引や棋譜保存を停止しません。
  await store.save([
    ...prepared.transitions.map(({ row, valid }) => store.transition(matchId, row, valid)),
    store.history(matchId),
    ...store.badges(prepared.record.game, matchId),
  ]);
}

/** 部屋閉鎖・再利用から独立して、確定前の引継ぎを少量ずつ回収します。 */
export async function retryPendingMatchClaims<Write>(
  store: MatchClaimStore<Write>,
  decode: DecodeMatch,
  runtime: ClaimRuntime,
  roomId?: string,
): Promise<void> {
  for (const matchId of await store.findPendingRetries(runtime.now(), roomId)) {
    await store.postponeRetry(matchId, runtime.now() + 5_000);
    try {
      await applyMatchClaims(store, matchId, decode);
    } catch {
      runtime.reportRetry("Pending match claim will be retried");
    }
  }
}
