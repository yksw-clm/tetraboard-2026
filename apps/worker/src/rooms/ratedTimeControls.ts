import {
  matchmakingQueues,
  type RatedMatchmakingGame,
  type RoomTimeControl,
} from "@tetraboard/protocol";

// 変更前に成立した対局も、終局保存の再試行を含めてレートへ反映します。
const previousTimeControls: Record<RatedMatchmakingGame, RoomTimeControl> = {
  "four-shogi": { mainTimeMs: 180_000, byoyomiMs: 0 },
  "four-reversi": { mainTimeMs: 180_000, byoyomiMs: 0 },
  shogi: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
  reversi: { mainTimeMs: 180_000, byoyomiMs: 0 },
};

export function ratedTimeControls(game: RatedMatchmakingGame): RoomTimeControl[] {
  return [matchmakingQueues[game].timeControl, previousTimeControls[game]];
}
