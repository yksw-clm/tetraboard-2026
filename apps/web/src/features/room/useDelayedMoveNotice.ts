import { useEffect, useState } from "react";
import type { PendingShogiAction } from "./fourShogiSessionBehavior";

export function useDelayedMoveNotice(
  pending: Extract<PendingShogiAction, { type: "move" }> | null,
) {
  const [delayed, setDelayed] = useState<typeof pending>(null);
  useEffect(() => {
    if (pending === null) return;
    const timer = window.setTimeout(
      () => setDelayed(pending),
      Math.max(0, Math.ceil(3000 - (performance.now() - pending.startedAtMs))),
    );
    return () => window.clearTimeout(timer);
  }, [pending]);
  return pending !== null && delayed === pending ? "着手を送信中…" : null;
}
