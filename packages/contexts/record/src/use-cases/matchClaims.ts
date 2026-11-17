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
