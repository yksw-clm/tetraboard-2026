import { createFourReversiSelection } from "@tetraboard/context-matchmaking";
import { fourReversiRatedMatchmakingRules, ratedMatchmakingRules } from "@tetraboard/protocol";
import { fourReversiRatingBeta } from "@tetraboard/context-rating";
import { findNamedCpuProfile } from "./cpuProfiles";
export const { calibratedFourReversiProfile, hasCalibratedFourReversiProfiles, selectFourReversi } =
  createFourReversiSelection({
    rules: fourReversiRatedMatchmakingRules,
    placementGames: ratedMatchmakingRules["four-reversi"].placementGames,
    beta: fourReversiRatingBeta,
    findNamedCpuProfile,
  });
