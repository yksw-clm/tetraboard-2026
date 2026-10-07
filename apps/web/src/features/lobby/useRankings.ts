import { defaultGameId } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, useState } from "react";
import { gameRankingContracts, type RankingsFor, type MatchGame } from "@tetraboard/protocol";

export function useRankings(game: MatchGame = defaultGameId) {
  const [rankings, setRankings] = useState<RankingsFor<MatchGame> | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (source: string | null = null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setPendingSource(source);
      if (!source?.endsWith("retry")) setError(null);
      try {
        const contract = gameRankingContracts[game];
        const response = await fetch(`/api${contract.path}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Rankings request failed");
        const result = contract.response.parse(await response.json());
        if (!controller.signal.aborted) {
          setRankings(result);
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) setError("ランキングを取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        if (request.current === controller) {
          request.current = null;
          setPendingSource(null);
        }
      }
    },
    [game],
  );
  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);
  return { rankings, loading, error, pendingSource, refresh };
}
