import { isRatedTimeControl, type SkillGame, type TimeControl } from "./policy";
export type SkillReference = { mu: number; sigma: number; profileId: string; profileHash?: string };
export type SkillParticipant = {
  kind: "human" | "cpu";
  seat: string;
  accountId?: string | null;
  cpuProfile?: { id: string; hash: string };
};
export type SkillMatch = {
  id: string;
  settings: { mode?: string; timeControl?: TimeControl; threePlayerAttackProhibited?: boolean };
  result: { mode: string; standings: { seat: string; rank: number }[] };
  participants: SkillParticipant[];
  source?: { usedFallback?: true; cpu: Partial<Record<string, SkillReference>> };
};
export type SkillPlayer =
  | { kind: "human"; accountId: string }
  | { kind: "cpu"; reference: { mu: number; sigma: number } };
export function eligibleSkillMatch(game: SkillGame, match: SkillMatch) {
  const { source, result, settings, participants: players } = match;
  if (
    !source ||
    source.usedFallback ||
    result.mode !== "singles" ||
    settings.mode !== "singles" ||
    (game === "four-shogi" && !settings.threePlayerAttackProhibited) ||
    !isRatedTimeControl(game, settings.timeControl)
  )
    return;
  const humans = players.filter((p) => p.kind === "human");
  const ids = humans.map((p) => p.accountId);
  const cpus = players.filter((p) => p.kind === "cpu");
  const ranks = players.map((p) => result.standings.find((s) => s.seat === p.seat)?.rank);
  if (
    players.length !== 4 ||
    new Set(players.map((p) => p.seat)).size !== 4 ||
    ranks.some((r) => r === undefined) ||
    !ids.length ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    cpus.length !== Object.keys(source.cpu).length ||
    cpus.some((p) => {
      const reference = source.cpu[p.seat];
      return (
        !reference ||
        (game === "four-reversi" &&
          (!p.cpuProfile ||
            reference.profileId !== p.cpuProfile.id ||
            reference.profileHash !== p.cpuProfile.hash))
      );
    })
  )
    return;
  return {
    players: players.map((p): SkillPlayer =>
      p.kind === "human"
        ? { kind: "human", accountId: p.accountId! }
        : { kind: "cpu", reference: source.cpu[p.seat]! },
    ),
    ranks: ranks as number[],
  };
}
