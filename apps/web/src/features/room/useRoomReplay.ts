import { type Room } from "@tetraboard/protocol";
import { useState } from "react";
import { replayFrames } from "./replayFrames";

export function useRoomReplay(room: Room) {
  const lastRound = room.status === "waiting" ? room.lastRound : null;
  const id = lastRound ? (lastRound.replay?.id ?? "legacy") : null;
  const frames = lastRound ? replayFrames(lastRound) : [];
  const [selection, setSelection] = useState({ id, index: frames.length - 1 });
  if (selection.id !== id) setSelection({ id, index: frames.length - 1 });
  const index = selection.id === id ? selection.index : frames.length - 1;
  const select = (next: number) => {
    if (Number.isInteger(next) && next >= 0 && next < frames.length)
      setSelection({ id, index: next });
  };
  return { frames, index, frame: frames[index] ?? null, select };
}
