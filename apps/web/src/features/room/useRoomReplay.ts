import { type FourReversiRoom, type LastRound } from "@tetraboard/protocol";
import { useState } from "react";
import { replayFrames } from "./replayFrames";
import { initialReplayIndex } from "./initialReplayIndex";

export function useRoomReplay(room: FourReversiRoom) {
  const lastRound = room.status === "waiting" ? room.lastRound : null;
  return useRoundReplay(lastRound);
}

export function useRoundReplay(lastRound: LastRound | null, initialPosition: string | null = null) {
  const id = lastRound ? (lastRound.replay?.id ?? "legacy") : null;
  const frames = lastRound ? replayFrames(lastRound) : [];
  const [selection, setSelection] = useState(() => ({
    id,
    index: initialReplayIndex(initialPosition, frames.length),
  }));
  if (selection.id !== id) setSelection({ id, index: frames.length - 1 });
  const index = selection.id === id ? selection.index : frames.length - 1;
  const select = (next: number) => {
    if (Number.isInteger(next) && next >= 0 && next < frames.length)
      setSelection({ id, index: next });
  };
  return { frames, index, frame: frames[index] ?? null, select };
}
