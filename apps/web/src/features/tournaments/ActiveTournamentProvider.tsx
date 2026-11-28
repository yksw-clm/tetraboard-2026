import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { TournamentLobbySections } from "@tetraboard/protocol";
import { isGameViewPath } from "../../shared/siteNavigation";
import { readLobbyTournaments } from "./tournamentLobbyApi";
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
        // 全ゲームの公開情報をまとめて取得し、本人の参加状態は取得しません。
        const data = await readLobbyTournaments("all", controller.signal);
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

  const serverNowMs = snapshot
    ? snapshot.data.serverTimeMs + Math.max(0, now - snapshot.receivedAt)
    : 0;
  useEffect(() => {
    if (!enabled || !snapshot) return;
    let nextDeadline = Infinity;
    for (const { startsAtMs, endsAtMs, status } of [
      ...snapshot.data.upcoming,
      ...snapshot.data.current,
    ]) {
      if (status === "settling" || status === "finished") continue;
      const deadline = startsAtMs > serverNowMs ? startsAtMs : endsAtMs;
      if (deadline > serverNowMs) nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (!Number.isFinite(nextDeadline)) return;
    const estimatedServerNow = snapshot.data.serverTimeMs + performance.now() - snapshot.receivedAt;
    const deadline = window.setTimeout(
      () => setNow(performance.now()),
      Math.min(Math.max(0, Math.ceil(nextDeadline - estimatedServerNow)), 2147483647),
    );
    return () => window.clearTimeout(deadline);
  }, [enabled, snapshot, serverNowMs]);

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
    <ActiveTournamentsContext
      value={{ tournaments, sections: enabled ? snapshot?.data : undefined, serverNowMs }}
    >
      {children}
    </ActiveTournamentsContext>
  );
}
