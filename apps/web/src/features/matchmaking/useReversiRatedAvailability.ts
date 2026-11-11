import { useEffect, useState } from "react";
import type { RatedMatchmakingGame } from "@tetraboard/protocol";
import { readRatedAvailability } from "./matchmakingApi";

export function useReversiRatedAvailability(active: boolean) {
  return useRatedAvailability("reversi", active);
}
export function useRatedAvailability(game: RatedMatchmakingGame, active: boolean) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void readRatedAvailability(game, controller.signal)
      .then((available) => {
        if (!controller.signal.aborted) setEnabled(available);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnabled(false);
      });
    return () => controller.abort();
  }, [active, game]);
  return active && enabled;
}
