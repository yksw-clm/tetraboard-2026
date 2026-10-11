import { useAccountDataRequest } from "./useAccountDataRequest";
import { isCurrentAccountRequest, StaleAccountRequestError } from "./accountRequestScope";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFourShogiFormationStatsContract,
  type FourShogiFormationStats,
} from "@tetraboard/protocol";

export function useFormationStats(enabled: boolean) {
  const { request: fetchData, generation } = useAccountDataRequest();
  const [state, setState] = useState({
    stats: null as FourShogiFormationStats | null,
    loaded: false,
    loading: false,
    pendingSource: null as string | null,
    error: null as string | null,
  });
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (source: string | null = null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState((current) => ({
        ...current,
        loading: true,
        pendingSource: source,
        error: source === "retry" ? current.error : null,
      }));
      let responseGeneration: number | undefined;
      try {
        const resultRequest = await fetchData(
          `/api${getFourShogiFormationStatsContract.path}`,
          controller.signal,
        );
        const { response } = resultRequest;
        responseGeneration = resultRequest.generation;
        if (!response.ok) throw new Error("Formation stats request failed");
        const stats = getFourShogiFormationStatsContract.response.parse(await response.json());
        const { formationCatalog } = await import("@tetraboard/four-shogi/formation-catalog");
        if (stats.some((entry) => !formationCatalog.some((known) => known.id === entry.id)))
          throw new Error("Unknown formation ID");
        if (!isCurrentAccountRequest(resultRequest.generation, controller.signal))
          throw new StaleAccountRequestError();
        if (!controller.signal.aborted)
          setState({ stats, loaded: true, loading: false, pendingSource: null, error: null });
      } catch (error) {
        if (
          error instanceof StaleAccountRequestError ||
          (responseGeneration !== undefined &&
            !isCurrentAccountRequest(responseGeneration, controller.signal))
        ) {
          if (!controller.signal.aborted)
            setState((current) => ({
              ...current,
              loaded: current.stats !== null,
              loading: false,
              pendingSource: null,
            }));
          return;
        }
        if (!controller.signal.aborted)
          setState((current) => ({
            ...current,
            loaded: true,
            loading: false,
            pendingSource: null,
            error: "戦法別戦績を取得できませんでした。",
          }));
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [fetchData],
  );
  useEffect(() => {
    if (!enabled || state.loaded || request.current) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [enabled, state.loaded, state.loading, generation, load]);
  useEffect(() => () => request.current?.abort(), []);
  return {
    ...state,
    loading: enabled && (!state.loaded || state.loading),
    refresh: (source: string | null = null) => (enabled ? load(source) : Promise.resolve()),
  };
}
