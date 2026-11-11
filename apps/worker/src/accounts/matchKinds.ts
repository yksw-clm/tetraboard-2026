import type { MatchKind } from "@tetraboard/protocol";
import type { DecodedMatch } from "./matchDataContracts";

export function withMatchKind<T extends { id: string }>(
  match: T,
  kinds?: ReadonlyMap<string, MatchKind>,
) {
  return kinds ? { ...match, matchKind: kinds.get(match.id) ?? ("unknown" as const) } : match;
}

export async function readMatchKinds(db: D1Database, records: readonly DecodedMatch[]) {
  const kinds = new Map<string, MatchKind>();
  if (!records.length) return kinds;
  const rows = await db
    .prepare(`SELECT id FROM tournament_matches WHERE id IN (${records.map(() => "?").join(",")})`)
    .bind(...records.map(({ record }) => record.id))
    .all<{ id: string }>();
  const tournaments = new Set(rows.results.map(({ id }) => id));
  for (const { record } of records) {
    const rated =
      ("fourReversiRating" in record && record.fourReversiRating !== undefined) ||
      ("fourShogiRating" in record && record.fourShogiRating !== undefined) ||
      ("rating" in record && record.rating !== undefined);
    kinds.set(
      record.id,
      tournaments.has(record.id) ? (rated ? "unknown" : "tournament") : rated ? "rated" : "normal",
    );
  }
  return kinds;
}
