import { createContext, useContext } from "react";
import type { TournamentPublic } from "@tetraboard/protocol";

export const ActiveTournamentsContext = createContext<{
  tournaments: TournamentPublic[];
  serverNowMs: number;
}>({ tournaments: [], serverNowMs: 0 });

export const useActiveTournaments = () => useContext(ActiveTournamentsContext);
