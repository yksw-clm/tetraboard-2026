import {
  type GomokuRoom as Room,
  type GomokuReplay,
  type GomokuMatchDetail,
} from "@tetraboard/protocol";

import { type GomokuState } from "@tetraboard/gomoku";

export type MatchParticipant = {
  id: string;
  name: string;
  color: NonNullable<Room["players"][number]["color"]>;
  seat: number;
} & ({ kind: "human"; accountId: string | null; retired?: true } | { kind: "cpu"; level: 1 | 2 });

export type MatchStart = {
  id: string;
  roomId: string;
  instanceId: string;
  startedAtMs: number;
  settings: GomokuMatchDetail["settings"];
  participants: MatchParticipant[];
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<GomokuState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: GomokuReplay;
};
export type PendingMatch = { record: MatchRecord; retryAtMs: number };
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";
