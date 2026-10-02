import { useCallback, useEffect, useRef, useState } from "react";
import {
  listMatchesContract,
  type MatchSummary,
  type MatchGame,
  type RoomMode,
} from "@tetraboard/protocol";
import { useAccountSelection } from "./useAccountSelection";

type HistoryPage = {
  matches: MatchSummary[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  moreLoading: boolean;
  error: string | null;
  failedMore: boolean;
};
const emptyPage = (): HistoryPage => ({
  matches: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  moreLoading: false,
  error: null,
  failedMore: false,
});
export function useMatchHistory() {
  const selection = useAccountSelection("history");
  const { game, mode } = selection;
  const [pages, setPages] = useState<Record<MatchGame, Record<RoomMode, HistoryPage>>>({
    "four-reversi": { singles: emptyPage(), doubles: emptyPage() },
    "four-shogi": { singles: emptyPage(), doubles: emptyPage() },
  });
  const requests = useRef<Partial<Record<`${MatchGame}:${RoomMode}`, AbortController>>>({});
  const page = pages[game][mode];

  const load = useCallback(
    async (targetGame: MatchGame, target: RoomMode, more = false) => {
      const key = `${targetGame}:${target}` as const;
      if (more && (requests.current[key] || !pages[targetGame][target].nextCursor)) return;
      requests.current[key]?.abort();
      const controller = new AbortController();
      requests.current[key] = controller;
      const cursor = more ? pages[targetGame][target].nextCursor : null;
      setPages((current) => ({
        ...current,
        [targetGame]: {
          ...current[targetGame],
          [target]: {
            ...current[targetGame][target],
            loading: !more,
            moreLoading: more,
            error: null,
            failedMore: false,
          },
        },
      }));
      try {
        const query = new URLSearchParams({ mode: target });
        if (targetGame === "four-shogi") query.set("game", targetGame);
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api${listMatchesContract.path}?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("History request failed");
        const result = listMatchesContract.response.parse(await response.json());
        if (result.matches.some((match) => match.game !== targetGame || match.mode !== target))
          throw new Error("History game or mode mismatch");
        if (controller.signal.aborted) return;
        setPages((current) => ({
          ...current,
          [targetGame]: {
            ...current[targetGame],
            [target]: {
              matches: more
                ? [
                    ...current[targetGame][target].matches,
                    ...result.matches.filter(
                      (match) =>
                        !current[targetGame][target].matches.some(
                          (existing) => existing.id === match.id,
                        ),
                    ),
                  ]
                : result.matches,
              nextCursor: result.nextCursor,
              loaded: true,
              loading: false,
              moreLoading: false,
              error: null,
              failedMore: false,
            },
          },
        }));
      } catch {
        if (!controller.signal.aborted)
          setPages((current) => ({
            ...current,
            [targetGame]: {
              ...current[targetGame],
              [target]: {
                ...current[targetGame][target],
                loaded: true,
                loading: false,
                moreLoading: false,
                failedMore: more,
                error: more
                  ? "続きの対局履歴を取得できませんでした。"
                  : "対局履歴を取得できませんでした。",
              },
            },
          }));
      } finally {
        if (requests.current[key] === controller) delete requests.current[key];
      }
    },
    [pages],
  );
  useEffect(() => {
    if (page.loaded || requests.current[`${game}:${mode}`]) return;
    const timeout = window.setTimeout(() => void load(game, mode), 0);
    return () => window.clearTimeout(timeout);
  }, [game, mode, page.loaded, load]);
  useEffect(
    () => () => {
      for (const controller of Object.values(requests.current)) controller?.abort();
    },
    [],
  );

  return {
    ...selection,
    page,
    refresh: () => load(game, mode),
    loadMore: () => load(game, mode, true),
    retry: () => load(game, mode, page.failedMore),
  };
}
