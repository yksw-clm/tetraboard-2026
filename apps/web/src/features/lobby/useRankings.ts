import { gameCatalog } from "@tetraboard/protocol/games";
import { defaultGameId } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  gameRankingContracts,
  previewRankingsSchema,
  previewReversiRankingsSchema,
  type PreviewReversiRankings,
  type PreviewRankings,
  type MatchGame,
  isRatedMatchmakingGame,
  ratingRankingContracts,
  type RatingRankings,
} from "@tetraboard/protocol";

export function useRankings(game: MatchGame = defaultGameId) {
  const [rankings, setRankings] = useState<PreviewRankings | PreviewReversiRankings | null>(null);
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
        const query = new URLSearchParams({ profilePreview: "1" });
        if (game === "four-shogi") query.set("includeKnockouts", "1");
        const response = await fetch(`/api${contract.path}?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Rankings request failed");
        const result = (
          !gameCatalog[game].hasModes ? previewReversiRankingsSchema : previewRankingsSchema
        ).parse(await response.json());
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
  const rating = useRatingRankings(game);
  return { game, rankings, loading, error, pendingSource, refresh, rating };
}

function useRatingRankings(game: MatchGame) {
  const supported = isRatedMatchmakingGame(game);
  const [data, setData] = useState<RatingRankings | null>(null);
  const [loading, setLoading] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (source: string | null = null) => {
      if (!isRatedMatchmakingGame(game)) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setPendingSource(source);
      if (!source?.endsWith("retry")) setError(null);
      try {
        const contract = ratingRankingContracts[game];
        const response = await fetch(`/api${contract.path}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Rating rankings request failed");
        const result = contract.response.parse(await response.json());
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) setError("レートランキングを取得できませんでした。");
      } finally {
        if (request.current === controller) {
          request.current = null;
          if (!controller.signal.aborted) {
            setLoading(false);
            setPendingSource(null);
          }
        }
      }
    },
    [game],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
    };
  }, [refresh]);
  return { supported, data, loading, error, pendingSource, refresh };
}
