import { replayV1, sameState } from "@tetraboard/gomoku/replay";
import type { GomokuLastRound } from "@tetraboard/protocol";
import { snapshotReplayPositions } from "@tetraboard/protocol/replay-positions";
import { useMemo, useState } from "react";
import { initialReplayIndex } from "./initialReplayIndex";
const names = { black: "黒", white: "白" };
const reasons = { resigned: "投了", left: "退室", timeout: "時間切れ", disconnected: "通信切れ" };
export function gomokuReplayFrames<T extends Pick<GomokuLastRound, "game" | "replay">>(
  lastRound: T,
) {
  const states = replayV1(lastRound.replay);
  if (!sameState(states.at(-1)!, lastRound.game)) throw new Error("Invalid Gomoku final state");
  return snapshotReplayPositions(lastRound.replay).map((position) => {
    if (position.kind !== "step") return { label: "開始局面", game: lastRound.replay.initial };
    const { action, game } = lastRound.replay.steps[position.stepIndex];
    return {
      label:
        action.type === "place"
          ? `${game.moveNumber}: ${names[action.color]} ${"ABCDEFGHIJKLMNO"[action.position.x]}${action.position.y + 1}`
          : `${names[action.color]} ${reasons[action.reason]}`,
      game,
    };
  });
}
export function useGomokuReplay(
  lastRound: GomokuLastRound | null,
  initialPosition: string | null = null,
) {
  const id = lastRound?.replay.id ?? null;
  const frames = useMemo(() => (lastRound ? gomokuReplayFrames(lastRound) : []), [lastRound]);
  const [selection, setSelection] = useState(() => ({
    id,
    index: initialReplayIndex(initialPosition, frames.length),
  }));
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
