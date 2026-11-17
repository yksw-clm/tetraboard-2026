import { createFourShogiSelection } from "@tetraboard/context-matchmaking";
import { matchmakingQueues, ratedCpuNames, ratedMatchmakingRules } from "@tetraboard/protocol";
import { fourReversiRatingBeta } from "@tetraboard/context-rating";
export const { calibratedFourShogiProfile, selectFourShogi } = createFourShogiSelection({
  rules: matchmakingQueues["four-shogi"],
  placementGames: ratedMatchmakingRules["four-shogi"].placementGames,
  beta: fourReversiRatingBeta,
  names: ratedCpuNames.fourShogi,
});
