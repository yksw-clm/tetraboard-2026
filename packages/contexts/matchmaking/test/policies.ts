import {
  createFourReversiSelection,
  createFourShogiSelection,
  createReversiCpuProfiles,
  createRatedMatchmakingPolicies,
} from "../src";

export const fourReversi = createFourReversiSelection({
  rules: { seats: 4, fillAfterMs: 20_000 },
  placementGames: 5,
  beta: 25 / 6,
  findNamedCpuProfile: (id) =>
    id === "lv3-v1"
      ? {
          id,
          engineVersion: "0.2.0",
          rulesetVersion: "four-reversi-singles-v2",
          stateVersion: 2,
          hash: "c2b327ed2e4beebdaee84931b35cea50bf8cbaf54831e6e116219a5913cbc748",
          agentId: "agent",
          level: 3,
          name: "ヨミ",
          style: "style",
        }
      : undefined,
});
export const fourShogi = createFourShogiSelection({
  rules: { seats: 4, fillAfterMs: 20_000 },
  placementGames: 5,
  beta: 25 / 6,
  names: { 4096: "弱", 16384: "中", 65536: "強" },
});
export const policies = createRatedMatchmakingPolicies({
  ...fourReversi,
  ...fourShogi,
  ...createReversiCpuProfiles({
    mix25: "1",
    mix50: "2",
    mix75: "3",
    level1: "4",
    level2: "5",
    level4: "6",
    level8: "7",
  }),
  queues: {
    shogi: { seats: 2, fillAfterMs: 15_000 },
    reversi: { seats: 2, fillAfterMs: 15_000 },
    "four-shogi": { seats: 4, fillAfterMs: 20_000 },
    "four-reversi": { seats: 4, fillAfterMs: 20_000 },
  },
  shogiInitialRating: 1500,
  initialFourReversiRating: { mu: 25, sigma: 25 / 3 },
});
