import {
  acceptMatchClaim as acceptClaim,
  applyMatchClaims as applyClaims,
  retryPendingMatchClaims as retryClaims,
  readClaimState,
  type MatchClaimInput,
  type MatchClaimGuard,
} from "@tetraboard/context-record";
import { readStoredMatch } from "../../adapters/record/matchDataContracts";
import { D1MatchClaimReadStore } from "../../adapters/record/matchClaimReadStore";
import { D1MatchClaimStore } from "../../adapters/record/matchClaimStore";
import { matchBadgeStatements } from "./badges";

const runtime = { now: () => Date.now(), reportRetry: (message: string) => console.error(message) };

const claimStore = (db: D1Database) =>
  new D1MatchClaimStore(db, (game, matchId) => matchBadgeStatements(db, game, matchId));

export function readMatchClaimState(
  db: D1Database,
  matchId: string,
  playerId: string,
  accountId: string,
) {
  return readClaimState(new D1MatchClaimReadStore(db), matchId, playerId, accountId);
}

export function acceptMatchClaim(db: D1Database, input: MatchClaimInput, guard?: MatchClaimGuard) {
  return acceptClaim(claimStore(db), input, readStoredMatch, runtime, guard);
}

export function applyMatchClaims(db: D1Database, matchId: string) {
  return applyClaims(claimStore(db), matchId, readStoredMatch);
}

export function retryPendingMatchClaims(db: D1Database, roomId?: string) {
  return retryClaims(claimStore(db), readStoredMatch, runtime, roomId);
}
