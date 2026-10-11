import { useAccountDataRequest } from "./useAccountDataRequest";
import { isCurrentAccountRequest, StaleAccountRequestError } from "./accountRequestScope";
import { gameCatalog } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listMatchesContract,
  type MatchSummary,
  type MatchGame,
  type RoomMode,
} from "@tetraboard/protocol";

type HistoryPage = {
  matches: MatchSummary[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  moreLoading: boolean;
  pendingSource: string | null;
  error: string | null;
  failedMore: boolean;
};
const emptyPage = (): HistoryPage => ({
  matches: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  moreLoading: false,
  pendingSource: null,
  error: null,
  failedMore: false,
});
export function useMatchHistory(game: MatchGame, mode: RoomMode) {
  const { request, generation } = useAccountDataRequest();
  const [pages, setPages] = useState<Record<MatchGame, Record<RoomMode, HistoryPage>>>({
    reversi: { singles: emptyPage(), doubles: emptyPage() },
    gomoku: { singles: emptyPage(), doubles: emptyPage() },
    shogi: { singles: emptyPage(), doubles: emptyPage() },
    "four-reversi": { singles: emptyPage(), doubles: emptyPage() },
    "four-shogi": { singles: emptyPage(), doubles: emptyPage() },
  });
  const requests = useRef<Partial<Record<`${MatchGame}:${RoomMode}`, AbortController>>>({});
  const page = pages[game][mode];

  const load = useCallback(
    async (targetGame: MatchGame, target: RoomMode, more = false, source: string | null = null) => {
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
            pendingSource: source,
            error: source === "retry" ? current[targetGame][target].error : null,
            failedMore: false,
          },
        },
      }));
      let responseGeneration: number | undefined;
      try {
        const query = new URLSearchParams(
          !gameCatalog[targetGame].hasModes ? {} : { mode: target },
        );
        if (targetGame !== "four-reversi") query.set("game", targetGame);
        if (cursor) query.set("cursor", cursor);
        const resultRequest = await request(
          `/api${listMatchesContract.path}?${query}`,
          controller.signal,
        );
        const { response } = resultRequest;
        responseGeneration = resultRequest.generation;
        if (!response.ok) throw new Error("History request failed");
        const result = listMatchesContract.response.parse(await response.json());
        if (
          result.matches.some(
            (match) =>
              match.game !== targetGame ||
              (gameCatalog[targetGame].hasModes && match.mode !== target),
          )
        )
          throw new Error("History game or mode mismatch");
        if (!isCurrentAccountRequest(resultRequest.generation, controller.signal))
          throw new StaleAccountRequestError();
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
              pendingSource: null,
              error: null,
              failedMore: false,
            },
          },
        }));
      } catch (error) {
        if (
          error instanceof StaleAccountRequestError ||
          (responseGeneration !== undefined &&
            !isCurrentAccountRequest(responseGeneration, controller.signal))
        ) {
          if (!controller.signal.aborted)
            setPages((current) => ({
              ...current,
              [targetGame]: {
                ...current[targetGame],
                [target]: {
                  ...current[targetGame][target],
                  loaded: current[targetGame][target].matches.length > 0,
                  loading: false,
                  moreLoading: false,
                  pendingSource: null,
                },
              },
            }));
          return;
        }
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
                pendingSource: null,
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
    [pages, request],
  );
  useEffect(() => {
    if (page.loaded || requests.current[`${game}:${mode}`]) return;
    const timeout = window.setTimeout(() => void load(game, mode), 0);
    return () => window.clearTimeout(timeout);
  }, [game, mode, page.loaded, page.loading, generation, load]);
  useEffect(
    () => () => {
      for (const controller of Object.values(requests.current)) controller?.abort();
    },
    [],
  );

  return {
    page,
    refresh: () => load(game, mode, false, "refresh"),
    loadMore: () => load(game, mode, true, "more"),
    retry: () => load(game, mode, page.failedMore, "retry"),
  };
}
