import { tournamentLobbySectionsSchema } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { accountRequest } from "../account/accountApi";
import { parseTournamentData, requestSignal } from "./tournamentRequest";

export async function readLobbyTournaments(game: GameId | "all", signal?: AbortSignal) {
  const query = new URLSearchParams({ view: "sections", game });
  return parseTournamentData(
    tournamentLobbySectionsSchema,
    await accountRequest(`/api/tournaments/lobby?${query}`, { signal: requestSignal(signal) }),
  );
}
