import {
  acceptMatchClaim as acceptClaim,
  applyMatchClaims as applyClaims,
  retryPendingMatchClaims as retryClaims,
  readClaimState,
  type MatchClaimInput,
  type MatchClaimGuard,
} from "@tetraboard/context-record";
import { readStoredMatch } from "./matchDataContracts";
import { D1MatchClaimReadStore } from "./matchClaimReadStore";
import { D1MatchClaimStore } from "./matchClaimStore";

const runtime = { now: () => Date.now(), reportRetry: (message: string) => console.error(message) };

export function readMatchClaimState(
  db: D1Database,
  matchId: string,
  playerId: string,
  accountId: string,
) {
  return readClaimState(new D1MatchClaimReadStore(db), matchId, playerId, accountId);
}

export function acceptMatchClaim(db: D1Database, input: MatchClaimInput, guard?: MatchClaimGuard) {
  return acceptClaim(new D1MatchClaimStore(db), input, readStoredMatch, runtime, guard);
}

export function applyMatchClaims(db: D1Database, matchId: string) {
  return applyClaims(new D1MatchClaimStore(db), matchId, readStoredMatch);
}

export function retryPendingMatchClaims(db: D1Database, roomId?: string) {
  return retryClaims(new D1MatchClaimStore(db), readStoredMatch, runtime, roomId);
}
