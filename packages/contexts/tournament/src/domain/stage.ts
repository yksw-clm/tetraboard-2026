import type { TournamentRow } from "./types";
export function stage(row: TournamentRow, now: number) {
  if (!row.published) return "draft" as const;
  if (row.finalized_at_ms !== null) return "finished" as const;
  if (now < row.starts_at_ms!) return "upcoming" as const;
  return now < row.ends_at_ms! ? ("active" as const) : ("settling" as const);
}
