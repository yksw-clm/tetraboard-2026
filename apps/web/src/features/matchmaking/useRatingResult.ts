import { useEffect, useState } from "react";
import type { RatedMatchmakingGame } from "@tetraboard/protocol";
import { readRatingResult } from "./matchmakingApi";

type Result = Awaited<ReturnType<typeof readRatingResult>>;

export function useRatingResult(
  game: RatedMatchmakingGame | undefined,
  matchId: string | undefined,
  profileId: string | undefined,
) {
  const [attempt, setAttempt] = useState(0);
  const key =
    game && matchId && profileId ? `${game}:${matchId}:${profileId}:${attempt}` : undefined;
  const [state, setState] = useState<{ key: string; result: Result | null; failed: boolean }>();
  useEffect(() => {
    if (!game || !matchId || !key) return;
    const controller = new AbortController();
    let timer: number | undefined;
    async function read(ratedGame: RatedMatchmakingGame, id: string, requestKey: string) {
      try {
        const result = await readRatingResult(ratedGame, id, controller.signal);
        if (controller.signal.aborted) return;
        setState({ key: requestKey, result, failed: false });
        if (result.status === "pending")
          timer = window.setTimeout(() => void read(ratedGame, id, requestKey), 1000);
      } catch {
        if (!controller.signal.aborted) setState({ key: requestKey, result: null, failed: true });
      }
    }
    void read(game, matchId, key);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [game, matchId, key]);
  const current = state?.key === key ? state : undefined;
  return {
    result: current?.result,
    failed: current?.failed,
    retry: () => setAttempt((a) => a + 1),
  };
}
