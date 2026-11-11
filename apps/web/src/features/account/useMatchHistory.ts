import { useAccountDataRequest } from "./useAccountDataRequest";
import { isCurrentAccountRequest, StaleAccountRequestError } from "./accountRequestScope";
import { gameCatalog } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listMatchesContract,
  type MatchHistoryFilter,
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
type HistoryKey = `${MatchGame}:${RoomMode}:${MatchHistoryFilter}`;
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
export function useMatchHistory(
  game: MatchGame,
  mode: RoomMode,
  filter: MatchHistoryFilter = "all",
) {
  const { request, generation } = useAccountDataRequest();
  const [pages, setPages] = useState<Partial<Record<HistoryKey, HistoryPage>>>({});
  const requests = useRef<Partial<Record<HistoryKey, AbortController>>>({});
  const key: HistoryKey = `${game}:${mode}:${filter}`;
  const page = pages[key] ?? emptyPage();
  const load = useCallback(
    async (
      targetGame: MatchGame,
      target: RoomMode,
      targetFilter: MatchHistoryFilter,
      more = false,
      source: string | null = null,
    ) => {
      const key: HistoryKey = `${targetGame}:${target}:${targetFilter}`;
      const previous = pages[key] ?? emptyPage();
      if (more && (requests.current[key] || !previous.nextCursor)) return;
      requests.current[key]?.abort();
      const controller = new AbortController();
      requests.current[key] = controller;
      const cursor = more ? previous.nextCursor : null;
      setPages((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? emptyPage()),
          loading: !more,
          moreLoading: more,
          pendingSource: source,
          error: source === "retry" ? (current[key]?.error ?? null) : null,
          failedMore: false,
        },
      }));
      let responseGeneration: number | undefined;
      try {
        const query = new URLSearchParams(
          !gameCatalog[targetGame].hasModes ? {} : { mode: target },
        );
        query.set("includeMoveCount", "1");
        query.set("includeMatchKind", "1");
        if (targetGame !== "four-reversi") query.set("game", targetGame);
        if (targetFilter !== "all") query.set("filter", targetFilter);
        if (cursor) query.set("cursor", cursor);
        const resultRequest = await request(
          `/api${listMatchesContract.path}?${query}`,
          controller.signal,
        );
        const { response } = resultRequest;
        responseGeneration = resultRequest.generation;
        if (!response.ok) throw new Error("History request failed");
        const result = listMatchesContract.response.parse(await response.json());
        if (targetFilter !== "all" && result.filter !== targetFilter)
          throw new Error("History filter was not applied");
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
          [key]: {
            matches: more
              ? [
                  ...(current[key]?.matches ?? []),
                  ...result.matches.filter(
                    (match) => !current[key]?.matches.some((existing) => existing.id === match.id),
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
              [key]: {
                ...(current[key] ?? emptyPage()),
                loaded: (current[key]?.matches.length ?? 0) > 0,
                loading: false,
                moreLoading: false,
                pendingSource: null,
              },
            }));
          return;
        }
        if (!controller.signal.aborted)
          setPages((current) => ({
            ...current,
            [key]: {
              ...(current[key] ?? emptyPage()),
              loaded: true,
              loading: false,
              moreLoading: false,
              pendingSource: null,
              failedMore: more,
              error: more
                ? "続きの対局履歴を取得できませんでした。"
                : "対局履歴を取得できませんでした。",
            },
          }));
      } finally {
        if (requests.current[key] === controller) delete requests.current[key];
      }
    },
    [pages, request],
  );
  useEffect(() => {
    if (page.loaded || requests.current[key]) return;
    const timeout = window.setTimeout(() => void load(game, mode, filter), 0);
    return () => window.clearTimeout(timeout);
  }, [game, mode, filter, key, page.loaded, page.loading, generation, load]);
  useEffect(
    () => () => {
      for (const controller of Object.values(requests.current)) controller?.abort();
    },
    [],
  );
  return {
    page,
    refresh: () => load(game, mode, filter, false, "refresh"),
    loadMore: () => load(game, mode, filter, true, "more"),
    retry: () => load(game, mode, filter, page.failedMore, "retry"),
  };
}
