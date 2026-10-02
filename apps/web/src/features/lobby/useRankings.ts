import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFourReversiRankingsContract,
  getFourShogiRankingsContract,
  type FourReversiRankings,
  type MatchGame,
} from "@tetraboard/protocol";

export function useRankings(game: MatchGame = "four-reversi") {
  const [rankings, setRankings] = useState<FourReversiRankings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const contract =
        game === "four-shogi" ? getFourShogiRankingsContract : getFourReversiRankingsContract;
      const response = await fetch(`/api${contract.path}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Rankings request failed");
      const result = contract.response.parse(await response.json());
      if (!controller.signal.aborted) setRankings(result);
    } catch {
      if (!controller.signal.aborted) setError("ランキングを取得できませんでした。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, [game]);
  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);
  return { rankings, loading, error, refresh };
}
