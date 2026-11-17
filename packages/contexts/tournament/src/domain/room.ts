import type {
  TournamentSettings,
  RoomSocketMessage,
  FourShogiRoom,
  FourReversiRoom,
  FourGomokuRoom,
  Room,
} from "@tetraboard/protocol";
export type TournamentAdmission = {
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
export type TournamentRoomContext = {
  matchSequence?: number;
  tournamentId: number;
  tournamentKey: string;
  matchId: string;
  startsAtMs: number;
  endsAtMs: number;
  ruleVersion: 1 | 2;
  settings?: TournamentSettings;
};

export type PrepareTournamentRoomInput = {
  context: TournamentRoomContext;
  roomId: string;
  instanceId: string;
  players: { admission: TournamentAdmission; tokenHash: string; credentialVersion?: number }[];
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
export type TournamentReturn = Extract<RoomSocketMessage, { type: "room.tournament.return" }>;
export type RekeyTournamentPlayerInput = {
  matchId: string;
  instanceId: string;
  accountId: string;
  operationId: string;
  playerId: string;
  version: number;
  tokenHash: string;
};

export type TournamentGameRoom = FourShogiRoom | FourReversiRoom | FourGomokuRoom;
export function isTournamentGameRoom(room: Room): room is TournamentGameRoom {
  return (
    room.settings.game === "four-shogi" ||
    room.settings.game === "four-reversi" ||
    room.settings.game === "four-gomoku"
  );
}
export const activeTournamentContextKey = "active-tournament-context";
