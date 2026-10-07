import type { FormationId, FormationMatch } from "@tetraboard/four-shogi";

export type FormationNotice = Readonly<{
  ids: readonly FormationId[];
  name: string;
}>;

export type FormationObservation = Readonly<{
  scope: string | null;
  ready: boolean;
  revision: number;
  moveNumber: number;
  ownMove: boolean;
  matches: readonly FormationMatch[];
}>;
export type FormationNoticeTracker = Readonly<{
  observation: FormationObservation;
  seen: readonly string[];
  notice: FormationNotice | null;
}>;

export function initialFormationTracker(
  observation: FormationObservation,
  seen: readonly string[] = [],
): FormationNoticeTracker {
  return {
    observation,
    seen: [...new Set([...seen, ...observation.matches.map((match) => match.id)])],
    notice: null,
  };
}

/** 連続して受信した本人の確定着手だけを通知し、取得済み局面は基準にします。 */
export function advanceFormationTracker(
  previous: FormationNoticeTracker,
  observation: FormationObservation,
): FormationNoticeTracker {
  const before = previous.observation;
  if (before.scope !== observation.scope) return initialFormationTracker(observation);
  if (
    !before.ready ||
    !observation.ready ||
    (observation.revision !== before.revision && observation.revision !== before.revision + 1)
  ) {
    return initialFormationTracker(observation, previous.seen);
  }
  const matches =
    observation.revision === before.revision + 1 &&
    observation.moveNumber === before.moveNumber + 1 &&
    observation.ownMove
      ? observation.matches.filter(
          (entry) =>
            !previous.seen.includes(entry.id) &&
            !before.matches.some((prior) => prior.id === entry.id),
        )
      : [];
  return {
    observation,
    seen: [...new Set([...previous.seen, ...observation.matches.map((entry) => entry.id)])],
    notice:
      matches.length > 0
        ? {
            ids: matches.map((match) => match.id),
            name: matches.map((match) => match.name).join("・"),
          }
        : previous.notice,
  };
}
