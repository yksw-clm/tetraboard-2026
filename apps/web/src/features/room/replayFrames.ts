import { type FourReversiState } from "@tetraboard/four-reversi";
import { type LastRound } from "@tetraboard/protocol";
import { colorNames, eliminationLabels } from "./roomPresentation";

export type ReplayFrame = { label: string; game: FourReversiState };

export function replayFrames(lastRound: LastRound): ReplayFrame[] {
  const replay = lastRound.replay;
  if (!replay) return [{ label: "最終局面（棋譜なし）", game: lastRound.game }];
  const frames: ReplayFrame[] = [{ label: "開始局面", game: replay.initial }];
  for (const { action, game, passedColors } of replay.steps) {
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
    frames.push({
      label:
        action.type === "place"
          ? `${game.moveNumber}: ${colorNames[action.color]}${"ABCDEFGH"[action.position.x]}${action.position.y + 1}`
          : `${colorNames[action.color]} ${eliminationLabels[action.reason]}`,
      game: beforePass(0),
    });
    passedColors.forEach((color, index) =>
      frames.push({
        label: `${colorNames[color]} パス`,
        game: beforePass(index + 1),
      }),
    );
  }
  return frames;
}
