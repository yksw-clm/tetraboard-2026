import { useCallback, useEffect, useRef, useState } from "react";
import { getFourReversiRankingsContract, type FourReversiRankings } from "@tetraboard/protocol";

export function useRankings() {
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
      const response = await fetch(`/api${getFourReversiRankingsContract.path}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Rankings request failed");
      const result = getFourReversiRankingsContract.response.parse(await response.json());
      if (!controller.signal.aborted) setRankings(result);
    } catch {
      if (!controller.signal.aborted) setError("ランキングを取得できませんでした。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);
  return { rankings, loading, error, refresh };
}
