import { replayV1, sameState } from "@tetraboard/four-gomoku/replay";
import type { FourGomokuLastRound } from "@tetraboard/protocol";
import type { FourGomokuState } from "@tetraboard/four-gomoku";
import { useMemo, useState } from "react";
const names = { black: "黒", white: "白", red: "赤", blue: "青" };
const reasons = { resigned: "投了", left: "退室", timeout: "時間切れ", disconnected: "通信切れ" };
export function fourGomokuReplayFrames(lastRound: FourGomokuLastRound) {
  const states = replayV1(lastRound.replay);
  if (!sameState(states.at(-1)!, lastRound.game)) throw new Error("Invalid FourGomoku final state");
  const frames: { label: string; game: FourGomokuState }[] = [
    { label: "開始局面", game: lastRound.replay.initial },
  ];
  for (const { action, game } of lastRound.replay.steps)
    frames.push({
      label:
        action.type === "place"
          ? `${game.moveNumber}: ${names[action.color]} ${"ABCDEFGHIJKLMNO"[action.position.x]}${action.position.y + 1}`
          : `${names[action.color]} ${reasons[action.reason]}`,
      game,
    });
  return frames;
}
export function useFourGomokuReplay(lastRound: FourGomokuLastRound | null) {
  const id = lastRound?.replay.id ?? null;
  const frames = useMemo(() => (lastRound ? fourGomokuReplayFrames(lastRound) : []), [lastRound]);
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
