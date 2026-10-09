import { gameCatalog } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountStatsContract, type AccountStats, type MatchGame } from "@tetraboard/protocol";

type StatsState = {
  stats: AccountStats | null;
  loaded: boolean;
  loading: boolean;
  pendingSource: string | null;
  error: string | null;
};
const empty = (): StatsState => ({
  stats: null,
  loaded: false,
  loading: false,
  pendingSource: null,
  error: null,
});

export function useAccountStats(game: MatchGame) {
  const [states, setStates] = useState<Record<MatchGame, StatsState>>({
    reversi: empty(),
    shogi: empty(),
    "four-reversi": empty(),
    "four-shogi": empty(),
  });
  const requests = useRef<Partial<Record<MatchGame, AbortController>>>({});
  const load = useCallback(async (target: MatchGame, source: string | null = null) => {
    requests.current[target]?.abort();
    const controller = new AbortController();
    requests.current[target] = controller;
    setStates((current) => ({
      ...current,
      [target]: {
        ...current[target],
        loading: true,
        pendingSource: source,
        error: source === "retry" ? current[target].error : null,
      },
    }));
    try {
      const query = target === "four-reversi" ? "" : `?game=${target}`;
      const response = await fetch(`/api${getAccountStatsContract.path}${query}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Stats request failed");
      const result = getAccountStatsContract.response.parse(await response.json());
      if (
        !gameCatalog[target].hasModes
          ? !("wins" in result)
          : !("singles" in result) || (target === "four-shogi") !== "knockouts" in result.singles
      )
        throw new Error("Stats game mismatch");
      if (!controller.signal.aborted)
        setStates((current) => ({
          ...current,
          [target]: {
            stats: result,
            loaded: true,
            loading: false,
            pendingSource: null,
            error: null,
          },
        }));
    } catch {
      if (!controller.signal.aborted)
        setStates((current) => ({
          ...current,
          [target]: {
            ...current[target],
            loaded: true,
            loading: false,
            pendingSource: null,
            error: "戦績を取得できませんでした。",
          },
        }));
    } finally {
      if (requests.current[target] === controller) delete requests.current[target];
    }
  }, []);
  const state = states[game];
  useEffect(() => {
    if (state.loaded || requests.current[game]) return;
    const timeout = window.setTimeout(() => void load(game), 0);
    return () => window.clearTimeout(timeout);
  }, [game, state.loaded, load]);
  useEffect(
    () => () => {
      for (const controller of Object.values(requests.current)) controller?.abort();
    },
    [],
  );
  return {
    ...state,
    loading: !state.loaded || state.loading,
    refresh: (source: string | null = null) => load(game, source),
  };
}
