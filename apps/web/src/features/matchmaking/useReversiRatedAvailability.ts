import { useEffect, useState } from "react";
import { readReversiRatedAvailability } from "./matchmakingApi";

export function useReversiRatedAvailability(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void readReversiRatedAvailability(controller.signal)
      .then((available) => {
        if (!controller.signal.aborted) setEnabled(available);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnabled(false);
      });
    return () => controller.abort();
  }, [active]);
  return active && enabled;
}
