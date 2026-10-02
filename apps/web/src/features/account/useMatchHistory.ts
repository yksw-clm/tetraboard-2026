import { useCallback, useEffect, useRef, useState } from "react";
import { listMatchesContract, type MatchSummary, type RoomMode } from "@tetraboard/protocol";

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
  const [mode, setMode] = useState<RoomMode>("singles");
  const [pages, setPages] = useState<Record<RoomMode, HistoryPage>>({
    singles: emptyPage(),
    doubles: emptyPage(),
  });
  const requests = useRef<Partial<Record<RoomMode, AbortController>>>({});
  const page = pages[mode];

  const load = useCallback(
    async (target: RoomMode, more = false) => {
      if (more && (requests.current[target] || !pages[target].nextCursor)) return;
      requests.current[target]?.abort();
      const controller = new AbortController();
      requests.current[target] = controller;
      const cursor = more ? pages[target].nextCursor : null;
      setPages((current) => ({
        ...current,
        [target]: {
          ...current[target],
          loading: !more,
          moreLoading: more,
          error: null,
          failedMore: false,
        },
      }));
      try {
        const query = new URLSearchParams({ mode: target });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`/api${listMatchesContract.path}?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("History request failed");
        const result = listMatchesContract.response.parse(await response.json());
        if (controller.signal.aborted) return;
        setPages((current) => ({
          ...current,
          [target]: {
            matches: more
              ? [
                  ...current[target].matches,
                  ...result.matches.filter(
                    (match) =>
                      !current[target].matches.some((existing) => existing.id === match.id),
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
        }));
      } catch {
        if (!controller.signal.aborted)
          setPages((current) => ({
            ...current,
            [target]: {
              ...current[target],
              loaded: true,
              loading: false,
              moreLoading: false,
              failedMore: more,
              error: more
                ? "続きの対局履歴を取得できませんでした。"
                : "対局履歴を取得できませんでした。",
            },
          }));
      } finally {
        if (requests.current[target] === controller) delete requests.current[target];
      }
    },
    [pages],
  );
  useEffect(() => {
    if (page.loaded || requests.current[mode]) return;
    const timeout = window.setTimeout(() => void load(mode), 0);
    return () => window.clearTimeout(timeout);
  }, [mode, page.loaded, load]);
  useEffect(
    () => () => {
      for (const controller of Object.values(requests.current)) controller?.abort();
    },
    [],
  );

  return {
    mode,
    setMode,
    page,
    refresh: () => load(mode),
    loadMore: () => load(mode, true),
    retry: () => load(mode, page.failedMore),
  };
}
