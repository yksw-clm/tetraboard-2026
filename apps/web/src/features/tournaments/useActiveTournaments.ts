import { createContext, useContext } from "react";
import type { TournamentPublic } from "@tetraboard/protocol";

export const ActiveTournamentsContext = createContext<{
  tournaments: TournamentPublic[];
  upcoming: TournamentPublic[];
  serverNowMs: number;
}>({ tournaments: [], upcoming: [], serverNowMs: 0 });

export const useActiveTournaments = () => useContext(ActiveTournamentsContext);
