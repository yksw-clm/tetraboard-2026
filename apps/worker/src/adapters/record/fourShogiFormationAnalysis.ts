import {
  detectFormations,
  formationAnalyzerId,
  formationAnalysisVersion,
  sides,
} from "@tetraboard/four-shogi";
import { isFourShogiRoom, type Room, type FourShogiFormationAnalysis } from "@tetraboard/protocol";

export const formationAnalysisTag = "formation-analysis-v1";

/** 通信の付加結果だけを生成し、ルーム・棋譜・保存データへ戻しません。 */
export function roomFormationAnalysis(
  room: Room,
  requested: boolean,
): {
  formationAnalysis?: FourShogiFormationAnalysis | null;
} {
  if (!requested || !isFourShogiRoom(room)) return {};
  if (room.status !== "playing") return { formationAnalysis: null };
  return {
    formationAnalysis: {
      analyzerId: formationAnalyzerId,
      analysisVersion: formationAnalysisVersion,
      rulesVersion: room.game.rulesVersion,
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      matches: Object.fromEntries(
        sides.map((side) => [side, detectFormations(room.game, side)]),
      ) as FourShogiFormationAnalysis["matches"],
    },
  };
}
