import type { FourReversiState } from "@tetraboard/four-reversi";
import type { LastRound } from "@tetraboard/protocol";
import { snapshotReplayPositions } from "@tetraboard/protocol/replay-positions";
import { colorNames, eliminationLabels } from "./roomPresentation";

export type ReplayFrame = { label: string; game: FourReversiState };

export function replayFrames<T extends Pick<LastRound, "game" | "replay">>(
  lastRound: T,
): ReplayFrame[] {
  const replay = lastRound.replay;
  return snapshotReplayPositions(replay).map((position) => {
    if (!replay || position.kind === "final")
      return { label: "最終局面（棋譜なし）", game: lastRound.game };
    if (position.kind === "initial") return { label: "開始局面", game: replay.initial };
    const { action, game, passedColors } = replay.steps[position.stepIndex];
    // エンジンが一度に処理した自動パスを、表示上は一色ずつたどれるようにします。
    const beforePass = (index: number): FourReversiState =>
      index < passedColors.length
        ? {
            ...game,
            status: "playing",
            turn: passedColors[index],
            consecutivePasses: passedColors.slice(0, index),
            result: null,
          }
        : game;
    if (position.kind === "pass")
      return {
        label: `${colorNames[passedColors[position.passIndex]]} パス`,
        game: beforePass(position.passIndex + 1),
      };
    return {
      label:
        action.type === "place"
          ? `${game.moveNumber}: ${colorNames[action.color]}${"ABCDEFGH"[action.position.x]}${action.position.y + 1}`
          : `${colorNames[action.color]} ${eliminationLabels[action.reason]}`,
      game: beforePass(0),
    };
  });
}
