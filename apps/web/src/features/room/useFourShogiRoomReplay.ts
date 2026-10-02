import { useEffect, useState } from "react";
import { type FourShogiRoom, type FourShogiLastRound } from "@tetraboard/protocol";
import { fetchFourShogiReplay, type FourShogiReplayFrame } from "./fourShogiReplay";

export function useFourShogiRoomReplay(room: FourShogiRoom) {
  const lastRound = room.status === "waiting" ? room.lastRound : null;
  const id = lastRound?.roundId ?? null;
  const [target, setTarget] = useState<FourShogiLastRound | null>(lastRound);
  if (target?.roundId !== lastRound?.roundId || target?.eventCount !== lastRound?.eventCount)
    setTarget(lastRound);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    id: string | null;
    frames: FourShogiReplayFrame[];
    error: string | null;
  }>({ id: null, frames: [], error: null });
  const [selection, setSelection] = useState({ id, index: -1 });
  if (id === null && loaded.id !== null) setLoaded({ id: null, frames: [], error: null });
  if (selection.id !== id) setSelection({ id, index: -1 });
  useEffect(() => {
    if (target === null) return;
    const targetId = target.roundId;
    const controller = new AbortController();
    void fetchFourShogiReplay({
      roomId: room.id,
      instanceId: room.instanceId,
      lastRound: target,
      signal: controller.signal,
    })
      .then((frames) => {
        if (controller.signal.aborted) return;
        setLoaded({ id: targetId, frames, error: null });
        setSelection({ id: targetId, index: frames.length - 1 });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoaded({
            id: targetId,
            frames: [],
            error: "棋譜を取得できませんでした。再度お試しください。",
          });
      });
    return () => controller.abort();
  }, [room.id, room.instanceId, target, retry]);
  const frames = id !== null && loaded.id === id ? loaded.frames : [];
  const index = selection.id === id ? selection.index : frames.length - 1;
  return {
    frames,
    index,
    frame: frames[index] ?? null,
    loading: id !== null && loaded.id !== id,
    error: id !== null && loaded.id === id ? loaded.error : null,
    retry: () => {
      setLoaded({ id: null, frames: [], error: null });
      setRetry((previous) => previous + 1);
    },
    select(next: number): void {
      if (Number.isInteger(next) && next >= 0 && next < frames.length)
        setSelection({ id, index: next });
    },
  };
}
