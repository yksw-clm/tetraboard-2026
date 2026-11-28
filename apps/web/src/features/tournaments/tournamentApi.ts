import {
  tournamentControllerResponseSchema,
  tournamentDetailSchema,
  tournamentListSchema,
  tournamentParticipationSchema,
  tournamentStandingsSchema,
} from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { accountRequest } from "../account/accountApi";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { parseTournamentData, requestSignal } from "./tournamentRequest";

export const tournamentPath = (id: number) => `/api/tournaments/${id}`;
export async function readTournament(id: number, signal?: AbortSignal) {
  return parseTournamentData(
    tournamentDetailSchema,
    await accountRequest(`${tournamentPath(id)}?includeProfiles=1`, {
      signal: requestSignal(signal),
    }),
  );
}
export async function readTournamentList(
  game: GameId | "all",
  cursor?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ game });
  if (cursor) query.set("cursor", cursor);
  return parseTournamentData(
    tournamentListSchema,
    await accountRequest(`/api/tournaments?${query}`, { signal: requestSignal(signal) }),
  );
}
export async function readTournamentParticipation(
  id: number,
  signal?: AbortSignal,
  controllerId?: string,
) {
  return parseTournamentData(
    tournamentParticipationSchema,
    await accountRequest(`${tournamentPath(id)}/participation`, {
      signal: requestSignal(signal),
      ...(controllerId ? { headers: { "X-Tournament-Controller": controllerId } } : {}),
    }),
  );
}
export async function readTournamentStandings(id: number, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ all: "1", includeProfiles: "1" });
  if (cursor) params.set("cursor", cursor);
  return parseTournamentData(
    tournamentStandingsSchema,
    await accountRequest(`${tournamentPath(id)}/standings?${params}`, {
      signal: requestSignal(signal),
    }),
  );
}
export async function tournamentOperation(
  id: number,
  operation: string,
  method: string,
  body: unknown,
  keepalive = false,
) {
  return accountRequest(`${tournamentPath(id)}/${operation}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method === "POST" ? { "X-Legal-Consent": legalVersion } : {}),
    },
    body: JSON.stringify(body),
    keepalive,
    ...(keepalive ? {} : { signal: requestSignal() }),
  });
}

export async function claimTournamentController(
  id: number,
  body: {
    operationId: string;
    controllerId: string;
    takeover: boolean;
    expectedControllerVersion: number;
  },
) {
  return parseTournamentData(
    tournamentControllerResponseSchema,
    await tournamentOperation(id, "controller", "POST", body),
  );
}
