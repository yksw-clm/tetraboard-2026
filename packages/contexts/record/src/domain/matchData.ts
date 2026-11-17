import type { GameId, MatchFor, CpuProfile } from "@tetraboard/protocol";
import type { StoredRecord, SnapshotReplay } from "./eventRecord";

export type ParticipantProfiles = ReadonlyMap<string, { name: string; avatarUrl: string | null }>;
type StoredPlayer<P> = P extends { kind: "human" }
  ? Omit<P, "avatarUrl"> & { accountId: string | null }
  : P;
type ReadonlyGame<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyGame<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyGame<T[Key]> }
    : T;
export type MatchRecordFor<G extends GameId> = Omit<
  MatchFor<G>,
  "selfPlayerId" | "matchKind" | "participants" | "game"
> & {
  game: ReadonlyGame<MatchFor<G>["game"]>;
  instanceId: string;
  participants: StoredPlayer<MatchFor<G>["participants"][number]>[];
  profileRatings?: unknown;
  rating?: unknown;
  fourReversiRating?: unknown;
  fourShogiRating?: unknown;
  aiFallback?: true;
};
export type RecordMatch = { [G in GameId]: { game: G; record: MatchRecordFor<G> } }[GameId];
export type StoredMatch = {
  [G in GameId]: {
    game: G;
    record: MatchRecordFor<G> extends { replay: SnapshotReplay }
      ? StoredRecord<MatchRecordFor<G>>
      : MatchRecordFor<G>;
  };
}[GameId];
export type ReadableRecordMatch = RecordMatch | StoredMatch;

export type SummaryMatch = {
  [G in GameId]: { game: G; record: Omit<MatchRecordFor<G>, "replay"> };
}[GameId];

function publicPlayers(match: SummaryMatch, profiles: ParticipantProfiles) {
  return match.record.participants.map((p) => {
    const identity = p.kind === "human" && p.accountId ? profiles.get(p.accountId) : undefined;
    return {
      id: p.id,
      ...("color" in p ? { color: p.color } : { side: p.side }),
      seat: p.seat,
      name: identity?.name ?? p.name,
      ...(p.kind === "human" && p.retired ? { retired: true as const } : {}),
      ...(p.kind === "cpu"
        ? {
            kind: p.kind,
            level: p.level,
            ...("cpuProfile" in p && p.cpuProfile
              ? { cpuProfile: p.cpuProfile as CpuProfile }
              : {}),
          }
        : { kind: p.kind, avatarUrl: identity?.avatarUrl ?? null }),
    };
  });
}
export function matchDetail(
  match: RecordMatch,
  selfPlayerId: string,
  profiles: ParticipantProfiles,
) {
  const {
    instanceId: _instance,
    aiFallback: _fallback,
    rating: _rating,
    fourReversiRating: _reversiRating,
    fourShogiRating: _shogiRating,
    profileRatings: _profiles,
    ...data
  } = match.record;
  return {
    ...data,
    selfPlayerId,
    participants: publicPlayers(match, profiles),
  } as MatchFor<GameId>;
}
export function publicMatchDetail(match: RecordMatch, profiles: ParticipantProfiles) {
  const { selfPlayerId: _self, ...detail } = matchDetail(
    match,
    match.record.participants[0].id,
    profiles,
  );
  return detail;
}
export function matchSummary(
  match: SummaryMatch,
  profiles: ParticipantProfiles,
  includeMoveCount = false,
) {
  const record = match.record;
  return {
    id: record.id,
    game: match.game,
    ...("mode" in record.settings ? { mode: record.settings.mode } : {}),
    startedAtMs: record.startedAtMs,
    endedAtMs: record.endedAtMs,
    participants: publicPlayers(match, profiles),
    result: record.game.result,
    ...(includeMoveCount ? { moveCount: record.game.moveNumber } : {}),
  };
}
