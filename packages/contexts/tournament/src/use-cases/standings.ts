import { rankTournamentStandings } from "../domain/ranking";
import type { TournamentRow, InternalStanding } from "../domain/types";
import { settingsForTournament } from "../domain/settings";
import { stage } from "../domain/stage";
import { standingFromRow, visibleStanding } from "../domain/standings";
import { nextOffset } from "../domain/cursor";
import type { TournamentReadPorts } from "./ports";
export async function allStandings(
  ports: TournamentReadPorts,
  row: TournamentRow,
): Promise<InternalStanding[]> {
  const values = await ports.store.scoreRows(row);
  const standings = values.map((row) => standingFromRow(row, ports.policy.avatarUrl));
  return row.finalized_at_ms === null
    ? rankTournamentStandings(standings, settingsForTournament(row, ports.policy).game)
    : standings.sort(
        (a, b) =>
          (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
          (a.username ?? "").localeCompare(b.username ?? ""),
      );
}
export async function standingsPage(
  ports: TournamentReadPorts,
  row: TournamentRow,
  viewer: string | undefined,
  all = false,
  offset = 0,
  includeProfiles = false,
) {
  if (stage(row, ports.now()) === "upcoming")
    return { standings: [], self: null, nextCursor: null };
  const values = await allStandings(ports, row);
  const own = values.find((v) => v.accountId === viewer);
  const page = all
    ? values.slice(offset, offset + 50)
    : values.filter((v) => v.rank !== null && v.rank <= 5);
  return {
    standings: page.map((v) => visibleStanding(v, viewer, includeProfiles)),
    self: own ? visibleStanding(own, viewer, includeProfiles) : null,
    nextCursor: all && values.length > offset + 50 ? nextOffset(offset + 50) : null,
  };
}
