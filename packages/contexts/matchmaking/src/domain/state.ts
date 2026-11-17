import type { MatchmakingGame } from "@tetraboard/protocol";
import type { QueueRatingSource } from "./ratedMatchmaking";
export type AccountAdmission = {
  accountId: string;
  operationId: string;
  roomId: string;
  instanceId: string;
  playerId: string;
  name: string;
  avatarKey: string | null;
  avatarPresetId?: string | null;
  isGuest?: boolean;
};
export type MatchmakingReason =
  | null
  | "cancelled"
  | "invalidated"
  | "unavailable"
  | "cpu_capacity"
  | "ai_unavailable"
  | "connection_timeout"
  | "lease_expired";
export type MatchmakingStage = "accepted" | "matched" | "retry" | "cancelled" | "failed";
export type Wait = {
  accountId: string;
  operationId: string;
  controllerId: string;
  version: number;
  joinedAtMs: number;
  sequence: number;
  retryAtMs?: number;
  diagnosticId?: string;
  rating?: number;
  sigma?: number;
  ratedGames?: number;
  expiresAtMs: number;
  isTest?: boolean;
};
export type Player = Wait & {
  admission: AccountAdmission;
  tokenHash: string;
  released?: boolean;
  credentialPending?: boolean;
};
export type Group = {
  assignSequence?: true;
  id: string;
  roomId: string;
  instanceId: string;
  preparedAtMs: number;
  expiresAtMs: number;
  phase: "preparing" | "matched" | "playing" | "cancelling";
  players: Player[];
  remove?: string[];
  retryDelayMs?: number;
  capacityBlocked?: true;
  rollbackReason?: MatchmakingReason;
  rating?: QueueRatingSource;
};
export type State = {
  key: string;
  waiting: Wait[];
  groups: Group[];
  nextSequence?: number;
  cpuRetryAtMs?: number;
};
export const cpuRetryDelayMs = 2000;
export type Profile = {
  id: string;
  name: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  isAnonymous: number | null;
  isTest: number | null;
};
export function compareWaits(a: Wait, b: Wait) {
  return (a.sequence ?? 0) - (b.sequence ?? 0) || a.joinedAtMs - b.joinedAtMs;
}
export type MatchmakingRoomInput = {
  matchSequence?: number;
  game?: MatchmakingGame;
  matchId: string;
  roomId: string;
  instanceId: string;
  preparedAtMs: number;
  expiresAtMs: number;
  players: {
    admission: AccountAdmission;
    tokenHash: string;
    version: number;
    search?: { operationId: string; joinedAtMs: number; isTest: boolean };
  }[];
  rating?: QueueRatingSource;
};
export type MatchmakingRoomReservation = MatchmakingRoomInput & {
  phase: "waiting" | "playing" | "closed";
  startsAtMs?: number;
  connectedPlayerIds?: string[];
  aiWarmup?:
    | { state: "pending"; attempts: number; nextAtMs: number }
    | { state: "ready" | "failed" };
  aiHumansConnected?: boolean;
};
