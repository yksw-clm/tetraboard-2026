import type { MatchKind, RegistrationEntry } from "@tetraboard/protocol";

type Common = {
  isTest: boolean;
  game?: string | null;
  browserId?: string | null;
  accountId?: string | null;
};

export type UsageEvent = Common &
  (
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
        stage: "accepted" | "matched" | "started" | "cancelled" | "failed" | "retry";
        reason:
          | "cpu_capacity"
          | "ai_unavailable"
          | "connection_timeout"
          | "lease_expired"
          | "invalidated"
          | "cancelled"
          | "unavailable"
          | null;
        rated: boolean;
        waitingMs?: number | null;
        humans?: number | null;
      }
    | {
        name: "registration";
        flowId?: string | null;
        stage:
          | "entry"
          | "oauth_start"
          | "oauth_success"
          | "registered"
          | "existing_login"
          | "profile_complete";
        entry: RegistrationEntry;
      }
    | {
        name: "visit_started";
        page: string;
        referrerClass: string;
        referrerHost?: string | null;
        utmSource?: string | null;
        utmMedium?: string | null;
        utmCampaign?: string | null;
        device: "smartphone" | "tablet" | "pc";
      }
    | { name: "client_error"; page: string; kind: string; message: string }
  );

export type UsageDataPoint = { indexes: string[]; blobs: string[]; doubles: number[] };
const flag = (value: boolean) => (value ? "1" : "0");
const truncate = (value: string, length: number) => Array.from(value).slice(0, length).join("");

export function usageDataPoint(event: UsageEvent): UsageDataPoint {
  let details: (string | null | undefined)[];
  let doubles: number[] = [];
  let id: string | null | undefined;
  switch (event.name) {
    case "match_started":
      id = event.matchId;
      details = [event.mode, event.matchKind];
      doubles = [event.humans, event.cpus];
      break;
    case "match_participant":
      id = event.matchId;
      details = [flag(event.isGuest)];
      break;
    case "match_ended":
      id = event.matchId;
      details = [event.result, event.reason];
      doubles = [event.durationMs];
      break;
    case "matchmaking":
      id = event.operationId;
      details = [event.stage, event.reason, flag(event.rated)];
      doubles = [event.waitingMs ?? 0, event.humans ?? 0];
      break;
    case "registration":
      id = event.flowId;
      details = [event.stage, event.entry];
      break;
    case "visit_started":
      details = [
        event.page,
        event.referrerClass,
        event.referrerHost,
        event.utmSource,
        event.utmMedium,
        event.utmCampaign,
        event.device,
      ];
      break;
    case "client_error":
      details = [event.page, event.kind, truncate(event.message, 200)];
      break;
  }
  return {
    indexes: [event.name],
    blobs: [
      event.name,
      flag(event.isTest),
      event.game,
      event.browserId,
      event.accountId,
      id,
      ...details,
    ].map((value) => truncate(value ?? "", 256)),
    doubles,
  };
}
