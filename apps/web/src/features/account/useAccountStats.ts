import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountStatsContract, type AccountStats } from "@tetraboard/protocol";

export function useAccountStats() {
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api${getAccountStatsContract.path}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Stats request failed");
      const result = getAccountStatsContract.response.parse(await response.json());
      if (!controller.signal.aborted) setStats(result);
    } catch {
      if (!controller.signal.aborted) setError("戦績を取得できませんでした。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [load]);
  return { stats, loading, error, refresh: load };
}
