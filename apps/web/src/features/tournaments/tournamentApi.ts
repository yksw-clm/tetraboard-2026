import {
  tournamentDetailSchema,
  tournamentLobbySchema,
  tournamentParticipationSchema,
  tournamentStandingsSchema,
} from "@tetraboard/protocol";
import { accountRequest } from "../account/accountApi";

export const tournamentPath = (id: number) => `/api/tournaments/${id}`;
function parseTournamentData<T>(schema: { parse: (body: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch {
    throw new Error("大会情報の応答を確認できません。もう一度お試しください。");
  }
}
function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export async function readTournament(id: number, signal?: AbortSignal) {
  return parseTournamentData(
    tournamentDetailSchema,
    await accountRequest(tournamentPath(id), { signal: requestSignal(signal) }),
  );
}
export async function readLobbyTournament(signal?: AbortSignal) {
  return parseTournamentData(
    tournamentLobbySchema,
    await accountRequest("/api/tournaments/lobby", { signal: requestSignal(signal) }),
  );
}
export async function readTournamentParticipation(id: number, signal?: AbortSignal) {
  return parseTournamentData(
    tournamentParticipationSchema,
    await accountRequest(`${tournamentPath(id)}/participation`, { signal: requestSignal(signal) }),
  );
}
export async function readTournamentStandings(id: number, cursor?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ all: "1" });
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
    ...(keepalive ? {} : { signal: requestSignal() }),
  });
}
