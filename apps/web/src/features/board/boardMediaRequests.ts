import { getPublicMatchContract, tournamentDetailSchema } from "@tetraboard/protocol";
import { tournamentPath } from "../tournaments/tournamentApi";
import { boardRequest } from "./boardApi";

export async function readBoardMatch(id: string, signal: AbortSignal) {
  const response = await boardRequest(
    getPublicMatchContract.pathFor(id),
    { signal },
    "棋譜を表示できません。",
  );
  return getPublicMatchContract.response.parse(await response.json()).match;
}

export async function readBoardTournamentName(id: number, signal: AbortSignal) {
  const response = await fetch(tournamentPath(id), { cache: "no-store", signal });
  if (!response.ok) throw new Error("Tournament unavailable");
  return tournamentDetailSchema.parse(await response.json()).tournament.name;
}
