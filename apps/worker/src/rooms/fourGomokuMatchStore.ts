import {
  type FourGomokuRoom as Room,
  type FourGomokuReplay,
  type FourGomokuMatchDetail,
} from "@tetraboard/protocol";

import { type FourGomokuState } from "@tetraboard/four-gomoku";

export type MatchParticipant = {
  id: string;
  name: string;
  color: NonNullable<Room["players"][number]["color"]>;
  seat: number;
} & ({ kind: "human"; accountId: string | null } | { kind: "cpu"; level: 1 | 2 });

export type MatchStart = {
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: FourGomokuMatchDetail["settings"];
  participants: MatchParticipant[];
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<FourGomokuState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: FourGomokuReplay;
};
export type PendingMatch = { record: MatchRecord; retryAtMs: number };
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";
