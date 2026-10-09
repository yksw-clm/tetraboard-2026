import type { ReversiLastRound } from "@tetraboard/protocol";
import type { ReversiState } from "@tetraboard/reversi";
import { useState } from "react";
const names = { black: "黒", white: "白" };
const reasons = { resigned: "投了", left: "退室", timeout: "時間切れ", disconnected: "通信切れ" };
export function reversiReplayFrames(lastRound: ReversiLastRound) {
  const frames: { label: string; game: ReversiState }[] = [
    { label: "開始局面", game: lastRound.replay.initial },
  ];
  for (const { action, game, passedColors } of lastRound.replay.steps) {
    const beforePass = (index: number): ReversiState =>
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
          ? `${game.moveNumber}: ${names[action.color]}${"ABCDEFGH"[action.position.x]}${action.position.y + 1}`
          : `${names[action.color]} ${reasons[action.reason]}`,
      game: beforePass(0),
    });
    passedColors.forEach((color, index) =>
      frames.push({ label: `${names[color]} パス`, game: beforePass(index + 1) }),
    );
  }
  return frames;
}
export function useReversiReplay(lastRound: ReversiLastRound | null) {
  const id = lastRound?.replay.id ?? null;
  const frames = lastRound ? reversiReplayFrames(lastRound) : [];
  const [selection, setSelection] = useState({ id, index: frames.length - 1 });
  if (selection.id !== id) setSelection({ id, index: frames.length - 1 });
  const index = selection.id === id ? selection.index : frames.length - 1;
  return {
    frames,
    index,
    frame: frames[index] ?? null,
    select: (next: number) => {
      if (Number.isInteger(next) && next >= 0 && next < frames.length)
        setSelection({ id, index: next });
    },
  };
}
