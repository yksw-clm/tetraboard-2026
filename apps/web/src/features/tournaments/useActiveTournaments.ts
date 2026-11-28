import { createContext, useContext } from "react";
import { getTournamentSettings, type TournamentPublic } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";

export const ActiveTournamentsContext = createContext<{
  tournaments: TournamentPublic[];
  upcoming: TournamentPublic[];
  serverNowMs: number;
}>({ tournaments: [], upcoming: [], serverNowMs: 0 });

export const useActiveTournaments = () => useContext(ActiveTournamentsContext);

export function useNextLobbyTournament(game: GameId) {
  const { upcoming, serverNowMs } = useActiveTournaments();
  return upcoming.find(
    (tournament) =>
      tournament.startsAtMs > serverNowMs && getTournamentSettings(tournament).game === game,
  );
}
