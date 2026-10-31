import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { TournamentLobbySections } from "@tetraboard/protocol";
import { isGameViewPath } from "../../shared/siteNavigation";
import { readLobbyTournaments } from "./tournamentApi";
import { ActiveTournamentsContext } from "./useActiveTournaments";

export function ActiveTournamentProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const enabled = !isGameViewPath(pathname);
  const [snapshot, setSnapshot] = useState<{
    data: TournamentLobbySections;
    receivedAt: number;
  } | null>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let request: AbortController | null = null;
    async function load() {
      if (disposed || request || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      request = controller;
      try {
        // 現在の大会対象は四人将棋だけです。参加状態はこの案内では取得しません。
        const data = await readLobbyTournaments("four-shogi", controller.signal);
        if (!disposed && !controller.signal.aborted) {
          const receivedAt = performance.now();
          setSnapshot({ data, receivedAt });
          setNow(receivedAt);
        }
      } catch {
        // 取得済み情報は期限まで保持し、初回失敗時は案内を出しません。
      } finally {
        if (request === controller) request = null;
      }
    }
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => void load(), 5000);
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(performance.now());
    }, 1000);
    const visibility = () => {
      setNow(performance.now());
      if (document.visibilityState === "visible") void load();
      else {
        request?.abort();
        request = null;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      request?.abort();
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !snapshot) return;
    const serverNow = snapshot.data.serverTimeMs + performance.now() - snapshot.receivedAt;
    const nextEnd = Math.min(
      ...snapshot.data.current
        .filter((tournament) => tournament.status === "active" && tournament.endsAtMs > serverNow)
        .map((tournament) => tournament.endsAtMs - serverNow),
    );
    if (!Number.isFinite(nextEnd)) return;
    const deadline = window.setTimeout(
      () => setNow(performance.now()),
      Math.min(nextEnd, 2147483647),
    );
    return () => window.clearTimeout(deadline);
  }, [enabled, snapshot, now]);

  const serverNowMs = snapshot
    ? snapshot.data.serverTimeMs + Math.max(0, now - snapshot.receivedAt)
    : 0;
  const tournaments =
    enabled && snapshot
      ? snapshot.data.current.filter(
          (tournament) =>
            tournament.status === "active" &&
            tournament.startsAtMs <= serverNowMs &&
            serverNowMs < tournament.endsAtMs,
        )
      : [];
  return (
    <ActiveTournamentsContext value={{ tournaments, serverNowMs }}>
      {children}
    </ActiveTournamentsContext>
  );
}
