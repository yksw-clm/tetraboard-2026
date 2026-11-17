import { tournamentMatchPoints, type TournamentMatchRecord } from "../domain/result";
import type { TournamentRoomContext } from "../domain/room";
import type { TournamentPolicy, TournamentPublication } from "./ports";
export function prepareTournamentMatch<Write>(
  store: TournamentPublication<Write>,
  context: TournamentRoomContext,
  record: TournamentMatchRecord,
  policy: TournamentPolicy,
  now: () => number,
): Write[] {
  const { settings, points } = tournamentMatchPoints(context, record, policy);
  return [
    ...points.map((points) => store.points(context, record, settings.game, points)),
    store.saved(context, record, now()),
  ];
}
