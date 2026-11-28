import { createContext, useContext } from "react";
import type { TournamentLobbySections, TournamentPublic } from "@tetraboard/protocol";

export const ActiveTournamentsContext = createContext<{
  tournaments: TournamentPublic[];
  sections?: TournamentLobbySections;
  serverNowMs: number;
}>({ tournaments: [], serverNowMs: 0 });

export const useActiveTournaments = () => useContext(ActiveTournamentsContext);
