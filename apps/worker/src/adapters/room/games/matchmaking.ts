import {
  matchmakingQueues,
  matchmakingRules,
  ratedCpuNames,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import type { MatchmakingRoomInput } from "@tetraboard/context-matchmaking";
import { calibratedFourShogiProfile } from "../../matchmaking/fourShogiSelection";
import { calibratedFourReversiProfile } from "../../matchmaking/fourReversiSelection";
import { namedCpuProfile } from "../../matchmaking/cpuProfiles";
import { reversiCpuProfile } from "../../matchmaking/reversiCpuProfiles";
import { shogiCpuProfile } from "@tetraboard/context-matchmaking";
import { ratedMatchmakingPolicy } from "../../matchmaking/ratedMatchmaking";
import { ratingOpponentKind } from "@tetraboard/context-matchmaking";

export function matchmakingRoomConfiguration(input: MatchmakingRoomInput) {
  const rating = input.rating;
  const game =
    input.game ??
    (rating?.kind === "reversi"
      ? "reversi"
      : rating?.kind === "four-shogi"
        ? "four-shogi"
        : rating && rating.kind !== "four-reversi"
          ? "shogi"
          : "four-reversi");
  const legacy = game === "four-reversi" && !rating;
  return {
    game,
    legacy,
    rules: legacy ? matchmakingRules : matchmakingQueues[game],
    policy: legacy ? undefined : ratedMatchmakingPolicy(game),
  };
}

export function matchmakingCpuAppearance(
  game: RatedMatchmakingGame,
  rating: MatchmakingRoomInput["rating"],
  legacy: boolean,
) {
  const profile = legacy
    ? namedCpuProfile("lv3-v1")
    : rating?.kind === "four-reversi" && rating.cpu
      ? calibratedFourReversiProfile(rating.cpu)
      : undefined;
  const fourShogiProfile =
    rating?.kind === "four-shogi" && rating.cpu
      ? calibratedFourShogiProfile(rating.cpu)
      : undefined;
  const shogiProfile =
    game === "shogi" && rating?.kind === "cpu" ? shogiCpuProfile(rating.profileId) : undefined;
  const cpuName =
    fourShogiProfile?.name ??
    (rating?.kind === "reversi" && rating.source.kind === "cpu"
      ? reversiCpuProfile(rating.source)?.name
      : shogiProfile?.standardBook
        ? ratedCpuNames.shogi[shogiProfile.nodes]
        : undefined);
  return { profile, cpuName };
}

export function matchmakingRoomMetadata(input: MatchmakingRoomInput) {
  const rating = input.rating;
  return {
    id: input.matchId,
    preparedAtMs: input.preparedAtMs,
    ...(rating?.kind === "four-reversi" || rating?.kind === "four-shogi"
      ? { rated: true }
      : rating
        ? { opponent: ratingOpponentKind(rating) }
        : {}),
  };
}
