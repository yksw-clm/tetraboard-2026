import type { MatchKind, Room } from "@tetraboard/protocol";

export type MatchUsageEvent = {
  isTest: boolean;
  game?: string | null;
  browserId?: string | null;
  accountId?: string | null;
} & (
  | {
      name: "match_started";
      matchId: string;
      mode: string;
      matchKind: MatchKind;
      humans: number;
      cpus: number;
    }
  | { name: "match_participant"; matchId: string; isGuest: boolean }
  | {
      name: "match_ended";
      matchId: string;
      result: "completed" | "abandoned";
      reason: string;
      durationMs: number;
    }
  | {
      name: "matchmaking";
      operationId: string;
      stage: "started";
      reason: null;
      rated: boolean;
      humans: number;
    }
);

export type RoomEffect =
  | { type: "broadcastRoom"; room: Room }
  | { type: "closeSockets"; tokenHash?: string }
  | { type: "sendMembership"; tokenHash: string }
  | { type: "chatChanged" }
  | { type: "usage"; event: MatchUsageEvent };

export type RoomOutcome<T> = { value: T; effects: RoomEffect[] };
