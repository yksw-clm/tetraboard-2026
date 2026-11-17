import { tournamentRankPointsUnits } from "./ranking";
import type { TournamentRoomContext } from "./room";
import type { TournamentSettings } from "@tetraboard/protocol";
import type { TournamentSettingsPolicy } from "./settings";
type Seat = { side: string } | { color: string };
export type TournamentMatchRecord = {
  id: string;
  roomId: string;
  instanceId: string;
  settings: unknown;
  startedAtMs: number;
  endedAtMs: number;
  game: {
    result?:
      | { mode: "singles"; standings: (Seat & { rank: number })[] }
      | { mode: "doubles" }
      | null;
  };
  participants: (Seat & { id: string; kind: string })[];
  knockouts?: Record<string, number>;
};
export type TournamentPoints = { playerId: string; rank: number; knockouts: number; units: number };
export function tournamentMatchPoints(
  context: TournamentRoomContext,
  record: TournamentMatchRecord,
  policy: TournamentSettingsPolicy & { pointsUnits: readonly number[] },
): { settings: TournamentSettings; points: TournamentPoints[] } {
  const settings = policy.settings(context);
  if (
    record.id !== context.matchId ||
    JSON.stringify(policy.parseSettings(record.settings)) !== JSON.stringify(settings) ||
    record.game.result?.mode !== "singles" ||
    record.participants.length !== 4 ||
    record.participants.some((p) => p.kind !== "human") ||
    record.startedAtMs < context.startsAtMs ||
    record.startedAtMs >= context.endsAtMs
  )
    throw new Error("Invalid tournament result");
  const standings = record.game.result.standings;
  const points = record.participants.map((p) => {
    const side = "side" in p ? p.side : p.color;
    const rank = standings.find((s) => ("side" in s ? s.side : s.color) === side)?.rank;
    if (!rank) throw new Error("Missing tournament rank");
    const units = tournamentRankPointsUnits(
      policy.pointsUnits,
      rank,
      standings.filter((s) => s.rank === rank).length,
    );
    return {
      playerId: p.id,
      rank,
      knockouts: "knockouts" in record && "side" in p ? record.knockouts![p.side]! : 0,
      units,
    };
  });
  return { settings, points };
}
