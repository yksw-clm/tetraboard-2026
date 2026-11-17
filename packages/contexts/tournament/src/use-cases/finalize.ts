import type { TournamentReadPorts, TournamentFinalization } from "./ports";
import { allStandings } from "./standings";
export async function finalizeTournament<Write>(
  ports: TournamentReadPorts,
  store: TournamentFinalization<Write>,
  key: string,
  now = ports.now(),
) {
  const row = await ports.store.read(key);
  if (!row || !row.published || row.finalized_at_ms !== null || row.ends_at_ms! > now) return;
  if (await store.pending(key)) return;
  const standings = await allStandings(ports, row);
  const guard = { key, entries: standings.length };
  await store.batch([
    ...standings.filter((v) => v.games > 0).map((v) => store.rank(v, guard)),
    ...standings
      .filter((v) => v.games > 0 && v.accountId && (v.rank === 1 || v.rank === 2))
      .map((v) =>
        store.notification(
          v,
          {
            id: row.public_id,
            name: row.name,
            rank: v.rank,
            tied: standings.filter((other) => other.rank === v.rank).length > 1,
          },
          now,
          guard,
        ),
      ),
    store.finish(key, now, guard),
  ]);
}
