import {
  type ReversiRoom as Room,
  type ReversiReplay,
  type ReversiMatchDetail,
} from "@tetraboard/protocol";

import { type ReversiState } from "@tetraboard/reversi";

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
  settings: ReversiMatchDetail["settings"];
  participants: MatchParticipant[];
};
export type MatchRecord = MatchStart & {
  endedAtMs: number;
  game: Extract<ReversiState, { status: "finished" }>;
  eliminations: Room["eliminations"];
  replay: ReversiReplay;
};
export type PendingMatch = { record: MatchRecord; retryAtMs: number };
export const matchStartKey = "match-start";
export const pendingMatchPrefix = "match-pending:";
