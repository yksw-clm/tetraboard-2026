import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFourShogiFormationStatsContract,
  type FourShogiFormationStats,
} from "@tetraboard/protocol";

export function useFormationStats(enabled: boolean) {
  const [state, setState] = useState({
    stats: null as FourShogiFormationStats | null,
    loaded: false,
    loading: false,
    pendingSource: null as string | null,
    error: null as string | null,
  });
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (source: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((current) => ({
      ...current,
      loading: true,
      pendingSource: source,
      error: source === "retry" ? current.error : null,
    }));
    try {
      const response = await fetch(`/api${getFourShogiFormationStatsContract.path}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Formation stats request failed");
      const stats = getFourShogiFormationStatsContract.response.parse(await response.json());
      const { formationCatalog } = await import("@tetraboard/four-shogi/formation-catalog");
      if (stats.some((entry) => !formationCatalog.some((known) => known.id === entry.id)))
        throw new Error("Unknown formation ID");
      if (!controller.signal.aborted)
        setState({ stats, loaded: true, loading: false, pendingSource: null, error: null });
    } catch {
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
  }, []);
  useEffect(() => {
    if (!enabled || state.loaded || request.current) return;
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [enabled, state.loaded, load]);
  useEffect(() => () => request.current?.abort(), []);
  return {
    ...state,
    loading: enabled && (!state.loaded || state.loading),
    refresh: (source: string | null = null) => (enabled ? load(source) : Promise.resolve()),
  };
}
