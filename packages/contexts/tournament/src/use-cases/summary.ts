import type { TournamentPublic, TournamentRecord } from "@tetraboard/protocol";
import type { TournamentRow, PublicCounts } from "../domain/types";
import { settingsForTournament } from "../domain/settings";
import { stage } from "../domain/stage";
import type { TournamentReadPorts, TournamentPolicy } from "./ports";
export async function record(
  ports: TournamentReadPorts,
  row: TournamentRow,
): Promise<TournamentRecord> {
  return {
    key: row.key,
    id: row.public_id,
    name: row.name,
    description: row.description,
    rulesDescription: row.rules_description,
    startsAtMs: row.starts_at_ms,
    endsAtMs: row.ends_at_ms,
    published: !!row.published,
    version: row.version,
    ruleVersion: row.rule_version,
    settings: settingsForTournament(row, ports.policy),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    entryCount: await ports.store.entryCount(row.key),
    status: stage(row, ports.now()),
  };
}
export function summarize(
  row: TournamentRow,
  counts: PublicCounts,
  now: number,
  policy: TournamentPolicy,
): TournamentPublic {
  if (!row.published || !row.public_id) throw new Error("Unpublished tournament");
  return {
    id: row.public_id,
    name: row.name,
    description: row.description,
    rulesDescription: row.rules_description,
    startsAtMs: row.starts_at_ms!,
    endsAtMs: row.ends_at_ms!,
    status: stage(row, now) as TournamentPublic["status"],
    ...counts,
    ruleVersion: row.rule_version,
    settings: settingsForTournament(row, policy),
    finalizedAtMs: row.finalized_at_ms,
  };
}
export async function publicSummary(
  ports: TournamentReadPorts,
  row: TournamentRow,
  now = ports.now(),
): Promise<TournamentPublic> {
  if (!row.published || !row.public_id) throw new Error("Unpublished tournament");
  const counts = await ports.store.counts(row.key);
  const waiting = await ports.store.waitingCount(row.key, now);
  return summarize(
    row,
    {
      entryCount: await ports.store.entryCount(row.key),
      waitingCount: waiting,
      playingCount: counts?.playing ?? 0,
      pendingCount: counts?.pending ?? 0,
      completedCount: counts?.completed ?? 0,
    },
    now,
    ports.policy,
  );
}
