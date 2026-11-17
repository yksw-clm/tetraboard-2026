import type { TournamentMatchRecord, TournamentRoomContext } from "@tetraboard/context-tournament";
import { legacyTournamentSettings } from "@tetraboard/protocol";
import { env } from "cloudflare:workers";
import { tournamentMatchStatements, type TournamentRow } from "../src/adapters/tournament/store";

export async function resultPublication(
  row: TournamentRow,
  players: { entryId: string }[],
  matchId: string,
  ranks: number[],
  knockouts: number[],
  db: D1Database = env.APP_DB,
) {
  const sides = ["south", "west", "north", "east"];
  const match = (await db
    .prepare("SELECT room_id,instance_id FROM tournament_matches WHERE id=?")
    .bind(matchId)
    .first<{ room_id: string; instance_id: string }>())!;
  const context: TournamentRoomContext = {
    tournamentKey: row.key,
    tournamentId: row.public_id!,
    matchId,
    startsAtMs: row.starts_at_ms!,
    endsAtMs: row.ends_at_ms!,
    ruleVersion: 1,
  };
  const record: TournamentMatchRecord = {
    id: matchId,
    roomId: match.room_id,
    instanceId: match.instance_id,
    settings: legacyTournamentSettings,
    startedAtMs: context.startsAtMs,
    endedAtMs: context.startsAtMs + 1000,
    participants: players.map((_, i) => ({ id: `player-${i}`, side: sides[i]!, kind: "human" })),
    game: {
      result: { mode: "singles", standings: sides.map((side, i) => ({ side, rank: ranks[i]! })) },
    },
    knockouts: Object.fromEntries(sides.map((side, i) => [side, knockouts[i]!])),
  };
  await db.batch(
    players.map((p, i) =>
      db
        .prepare(
          "INSERT INTO tournament_match_players(match_id,entry_id,player_id,operation_id) VALUES(?,?,?,?)",
        )
        .bind(matchId, p.entryId, `player-${i}`, crypto.randomUUID()),
    ),
  );
  return () =>
    db.batch([
      db
        .prepare(
          "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES(?,'four-shogi','singles',?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(matchId, record.startedAtMs, record.endedAtMs, JSON.stringify(record)),
      ...tournamentMatchStatements(db, context, record),
    ]);
}
