import type { AccountAdmission } from "../accounts/roomAccounts";
import { z } from "zod";
import { tournamentRules } from "@tetraboard/protocol";

export type TournamentRoomContext = {
  tournamentId: number;
  tournamentKey: string;
  matchId: string;
  startsAtMs: number;
  endsAtMs: number;
  ruleVersion: 1;
};

export type PrepareTournamentRoomInput = {
  context: TournamentRoomContext;
  roomId: string;
  instanceId: string;
  players: { admission: AccountAdmission; tokenHash: string; credentialVersion?: number }[];
};

export type TournamentRoomReservation = {
  context: TournamentRoomContext;
  roomId: string;
  instanceId: string;
  status: "waiting" | "playing" | "closed";
  preparedAtMs: number;
  startedAtMs?: number;
  connectedPlayerIds?: string[];
  excludedPlayerIds?: string[];
};

export type PendingTournamentState = {
  reservation: TournamentRoomReservation;
  phase: "playing" | "saving" | "aborted";
  retryAtMs: number;
};

export const tournamentRoomKey = "tournament-room";
export const tournamentReservationKey = (matchId: string) => `tournament-reservation:${matchId}`;
export const pendingTournamentStatePrefix = "tournament-state-pending:";
export const cancelledTournamentKey = (matchId: string) => `tournament-cancelled:${matchId}`;
export const tournamentCredentialVersionKey = (playerId: string) =>
  `tournament-credential-version:${playerId}`;
export const tournamentReturnKey = "tournament-return";
export type TournamentReturn = Extract<
  import("@tetraboard/protocol").RoomSocketMessage,
  { type: "room.tournament.return" }
>;
export type RekeyTournamentPlayerInput = {
  matchId: string;
  instanceId: string;
  accountId: string;
  operationId: string;
  playerId: string;
  version: number;
  tokenHash: string;
};

export const prepareTournamentRoomSchema = z.strictObject({
  context: z.strictObject({
    tournamentId: z.int().positive(),
    tournamentKey: z.string().min(1).max(200),
    matchId: z.uuid(),
    startsAtMs: z.int().nonnegative(),
    endsAtMs: z.int().nonnegative(),
    ruleVersion: z.literal(tournamentRules.version),
  }),
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  players: z
    .array(
      z.strictObject({
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        credentialVersion: z.int().nonnegative().optional(),
        admission: z.strictObject({
          accountId: z.string().min(1),
          operationId: z.string().min(1),
          roomId: z.string().regex(/^\d{5}$/),
          instanceId: z.uuid(),
          playerId: z.uuid(),
          name: z.string().min(1),
          avatarKey: z.string().nullable(),
        }),
      }),
    )
    .length(4),
});

export async function writeTournamentState(db: D1Database, job: PendingTournamentState) {
  const { reservation, phase } = job;
  await db
    .prepare(`UPDATE tournament_matches SET phase=?,
      started_at_ms=COALESCE(started_at_ms,?),
      finished_at_ms=CASE WHEN ? IN ('saving','aborted') THEN COALESCE(finished_at_ms,?) ELSE finished_at_ms END,
      updated_at_ms=?
      WHERE id=? AND tournament_key=? AND room_id=? AND instance_id=?
        AND (phase IN ('reserved','playing') OR (phase='saving' AND ? IN ('saving','aborted')))`)
    .bind(
      phase,
      reservation.startedAtMs ?? null,
      phase,
      Date.now(),
      Date.now(),
      reservation.context.matchId,
      reservation.context.tournamentKey,
      reservation.roomId,
      reservation.instanceId,
      phase,
    )
    .run();
}
