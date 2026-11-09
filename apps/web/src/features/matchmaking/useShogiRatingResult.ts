import { useEffect, useState } from "react";
import { readShogiRatingResult } from "./matchmakingApi";

type Result = Awaited<ReturnType<typeof readShogiRatingResult>>;

export function useShogiRatingResult(matchId: string | undefined, profileId: string | undefined) {
  const [attempt, setAttempt] = useState(0);
  const key = matchId && profileId ? `${matchId}:${profileId}:${attempt}` : undefined;
  const [state, setState] = useState<{ key: string; result: Result | null; failed: boolean }>();
  useEffect(() => {
    if (!matchId || !key) return;
    const controller = new AbortController();
    let timer: number | undefined;
    async function read(id: string, requestKey: string) {
      try {
        const result = await readShogiRatingResult(id, controller.signal);
        if (controller.signal.aborted) return;
        setState({ key: requestKey, result, failed: false });
        if (result.status === "pending")
          timer = window.setTimeout(() => void read(id, requestKey), 1000);
      } catch {
        if (!controller.signal.aborted) setState({ key: requestKey, result: null, failed: true });
      }
    }
    void read(matchId, key);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [matchId, key]);
  const current = state?.key === key ? state : undefined;
  return {
    result: current?.result,
    failed: current?.failed,
    retry: () => setAttempt((a) => a + 1),
  };
}
