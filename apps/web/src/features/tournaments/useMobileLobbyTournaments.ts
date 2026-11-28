import {
  getTournamentSettings,
  type TournamentPublic,
  type TournamentStage,
} from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { useActiveTournaments } from "./useActiveTournaments";

export type MobileLobbyTournaments = {
  active: TournamentPublic[];
  upcoming: TournamentPublic[];
  stages: ReadonlyMap<number, TournamentStage>;
  announcedId?: number;
  serverNowMs?: number;
};

export function mobileTournamentStage(
  { status, startsAtMs, endsAtMs }: Pick<TournamentPublic, "status" | "startsAtMs" | "endsAtMs">,
  serverNowMs: number,
): TournamentStage {
  if (!serverNowMs || status === "finished" || status === "settling") return status;
  if (serverNowMs < startsAtMs) return "upcoming";
  return serverNowMs < endsAtMs ? "active" : "settling";
}

export function useMobileLobbyTournaments(
  game: GameId,
  enabled: boolean,
): MobileLobbyTournaments | undefined {
  const { sections, serverNowMs } = useActiveTournaments();
  if (!enabled || !sections) return undefined;
  const active: TournamentPublic[] = [];
  const upcoming: TournamentPublic[] = [];
  const stages = new Map<number, TournamentStage>();
  for (const tournament of [...sections.current, ...sections.upcoming]) {
    if (getTournamentSettings(tournament).game !== game) continue;
    const status = mobileTournamentStage(tournament, serverNowMs);
    stages.set(tournament.id, status);
    if (status === "active") active.push({ ...tournament, status });
    if (status === "upcoming") upcoming.push({ ...tournament, status });
  }
  active.sort((a, b) => b.endsAtMs - a.endsAtMs || b.id - a.id);
  return { active, upcoming, stages, serverNowMs, announcedId: upcoming[0]?.id };
}
