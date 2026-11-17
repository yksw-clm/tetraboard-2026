import type {
  TournamentPublic,
  TournamentLobbySections,
  TournamentList,
  TournamentListItem,
} from "@tetraboard/protocol";
import type { GameScope } from "@tetraboard/protocol/games";
import type { TournamentRow, InternalStanding } from "../domain/types";
import { settingsForTournament } from "../domain/settings";
import { stage } from "../domain/stage";
import { standingFromRow, visibleStanding } from "../domain/standings";
import { nextOffset } from "../domain/cursor";
import type { TournamentReadPorts, TournamentPolicy } from "./ports";
import { record, summarize } from "./summary";
export async function lobbySections(
  ports: TournamentReadPorts,
  game: GameScope,
  now: number,
): Promise<TournamentLobbySections> {
  const cutoff = now - 86_400_000;
  const rows = await ports.store.lobbyRows(game, now, cutoff);
  const current: TournamentPublic[] = [],
    upcoming: TournamentPublic[] = [];
  for (const row of rows) {
    const summary = summarize(
      row,
      {
        entryCount: row.entryCount,
        waitingCount: row.waitingCount,
        playingCount: row.playingCount,
        pendingCount: row.pendingCount,
        completedCount: row.completedCount,
      },
      now,
      ports.policy,
    );
    if (summary.status === "upcoming") upcoming.push(summary);
    else if (summary.status === "active" || summary.endsAtMs <= now) current.push(summary);
  }
  current.sort(
    (a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      b.endsAtMs - a.endsAtMs ||
      b.id - a.id,
  );
  upcoming.sort((a, b) => a.startsAtMs - b.startsAtMs || a.id - b.id);
  return { current, upcoming, serverTimeMs: now };
}
export async function publicTournamentList(
  ports: TournamentReadPorts,
  game: GameScope,
  cursor: string | undefined,
  now: number,
): Promise<TournamentList> {
  const result = await ports.store.listRows(game, cursor);
  const rows = result.slice(0, 20);
  const finalized = rows.filter((row) => row.finalized_at_ms !== null).map((row) => row.key);
  const winners = new Map<string, InternalStanding[]>();
  if (finalized.length) {
    const scores = await ports.store.winnerRows(finalized);
    for (const score of scores) {
      const group = winners.get(score.tournamentKey) ?? [];
      group.push(standingFromRow(score, ports.policy.avatarUrl));
      winners.set(score.tournamentKey, group);
    }
  }
  const tournaments = rows.map((row) =>
    listItem(row, winners.get(row.key) ?? [], now, ports.policy),
  );
  const last = rows.at(-1);
  return {
    tournaments,
    nextCursor: result.length > 20 && last ? `${last.starts_at_ms}:${last.public_id}` : null,
    serverTimeMs: now,
  };
}
function listItem(
  row: TournamentRow & { entryCount: number },
  winners: InternalStanding[],
  now: number,
  policy: TournamentPolicy,
): TournamentListItem {
  return {
    id: row.public_id!,
    game: settingsForTournament(row, policy).game,
    ruleVersion: row.rule_version,
    settings: settingsForTournament(row, policy),
    name: row.name,
    entryCount: row.entryCount,
    startsAtMs: row.starts_at_ms!,
    endsAtMs: row.ends_at_ms!,
    status: stage(row, now) as TournamentPublic["status"],
    winners: winners
      .sort(
        (a, b) =>
          (a.username ?? "").localeCompare(b.username ?? "") || a.entryId.localeCompare(b.entryId),
      )
      .map((standing) => {
        const { name, avatarUrl, isGuest } = visibleStanding(standing);
        return { name, avatarUrl, ...(isGuest ? { isGuest: true } : {}) };
      }),
  };
}
export async function adminList(ports: TournamentReadPorts, offset: number) {
  const rows = await ports.store.adminRows(offset);
  return {
    tournaments: await Promise.all(rows.slice(0, 50).map((row) => record(ports, row))),
    nextCursor: rows.length > 50 ? nextOffset(offset + 50) : null,
  };
}
