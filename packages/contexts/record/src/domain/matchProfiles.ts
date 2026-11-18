import type { ReadableRecordMatch } from "./matchData";

export type MatchParticipantClaim = {
  match_id: string;
  player_id: string;
  account_id: string | null;
  state: "applied" | "retired";
};

export function indexMatchClaims(rows: MatchParticipantClaim[]) {
  const claims = new Map<string, Map<string, string | null>>();
  const retiredPlayers = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.state === "applied") {
      if (!claims.has(row.match_id)) claims.set(row.match_id, new Map());
      claims.get(row.match_id)!.set(row.player_id, row.account_id);
    } else if (row.state === "retired") {
      if (!retiredPlayers.has(row.match_id)) retiredPlayers.set(row.match_id, new Set());
      retiredPlayers.get(row.match_id)!.add(row.player_id);
    }
  }
  return { claims, retiredPlayers };
}

export function applyParticipantClaims<R extends ReadableRecordMatch["record"]>(
  record: R,
  applied: ReadonlyMap<string, string | null> | undefined,
): R {
  return {
    ...record,
    participants: record.participants.map((player) => {
      if (player.kind !== "human" || player.retired || !applied?.has(player.id)) return player;
      const claimedId = applied.get(player.id)!;
      if (player.accountId !== null && player.accountId !== claimedId)
        throw new Error("Conflicting match participant identity");
      return { ...player, accountId: claimedId };
    }),
  };
}

export function participantAccountIds(records: readonly ReadableRecordMatch[]): string[] {
  return [
    ...new Set(
      records.flatMap(({ record }) =>
        record.participants.flatMap((player) =>
          player.kind === "human" && player.accountId ? [player.accountId] : [],
        ),
      ),
    ),
  ];
}
