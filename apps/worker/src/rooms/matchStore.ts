import type {
  ProfileRatings,
  FourReversiRoom as Room,
  RoundReplay,
  FourReversiMatchDetail,
} from "@tetraboard/protocol";
import type { FourReversiState } from "@tetraboard/four-reversi";
import type { FourReversiRatedMatch } from "./fourReversiRating";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";

export type MatchParticipant = {
  id: string;
  name: string;
  color: NonNullable<Room["players"][number]["color"]>;
  seat: number;
} & (
  | { kind: "human"; accountId: string | null; retired?: true }
  | { kind: "cpu"; level: 1 | 2; cpuProfile?: import("@tetraboard/protocol").CpuProfile }
);

export type MatchStart = {
  profileRatings?: ProfileRatings;
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourReversiMatchDetail["settings"];
  participants: MatchParticipant[];
  fourReversiRating?: FourReversiRatedMatch;
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<FourReversiState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: RoundReplay;
};
export type PendingMatch = {
  record: MatchRecord;
  tournament?: TournamentRoomContext;
  retryAtMs: number;
};
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";
