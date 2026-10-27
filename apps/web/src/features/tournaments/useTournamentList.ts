import { useCallback, useEffect, useRef, useState } from "react";
import type { TournamentListItem } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { readTournamentList } from "./tournamentApi";

type Game = GameId | "all";
type Page = {
  game: Game;
  tournaments: TournamentListItem[];
  nextCursor: string | null;
  loaded: boolean;
  pending: "refresh" | "more" | null;
  error: string | null;
};
function emptyPage(game: Game): Page {
  return { game, tournaments: [], nextCursor: null, loaded: false, pending: null, error: null };
}
function checkPage(
  game: Game,
  tournaments: TournamentListItem[],
  nextCursor: string | null,
  seenCursors: Set<string>,
) {
  if (tournaments.some((tournament) => game !== "all" && tournament.game !== game))
    throw new Error("大会一覧の取得条件が一致しませんでした。");
  if (nextCursor && seenCursors.has(nextCursor))
    throw new Error("大会一覧の続きを取得できませんでした。");
}

export function useTournamentList(game: Game) {
  const [page, setPage] = useState(() => emptyPage(game));
  const request = useRef<AbortController | null>(null);
  const pageCount = useRef(1);
  const consumedCursors = useRef(new Set<string>());
  const currentPage = page.game === game ? page : emptyPage(game);

  const refresh = useCallback(async () => {
    if (request.current || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    request.current = controller;
    setPage((previous) => ({
      ...(previous.game === game ? previous : emptyPage(game)),
      pending: "refresh",
    }));
    try {
      const collected = new Map<number, TournamentListItem>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let nextCursor: string | null = null;
      let loadedPages = 0;
      do {
        if (cursor) seenCursors.add(cursor);
        const data = await readTournamentList(game, cursor, controller.signal);
        if (controller.signal.aborted) return;
        checkPage(game, data.tournaments, data.nextCursor, seenCursors);
        for (const tournament of data.tournaments) collected.set(tournament.id, tournament);
        nextCursor = data.nextCursor;
        cursor = nextCursor ?? undefined;
        loadedPages++;
      } while (cursor && loadedPages < pageCount.current);
      pageCount.current = loadedPages;
      consumedCursors.current = seenCursors;
      setPage({
        game,
        tournaments: [...collected.values()],
        nextCursor,
        loaded: true,
        pending: null,
        error: null,
      });
    } catch {
      if (!controller.signal.aborted)
        setPage((previous) => ({
          ...(previous.game === game ? previous : emptyPage(game)),
          pending: null,
          error: "大会一覧を取得できませんでした。",
        }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [game]);

  useEffect(() => {
    pageCount.current = 1;
    consumedCursors.current = new Set();
    const timeout = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 5000);
    const visibility = () => {
      if (document.visibilityState === "visible") void refresh();
      else {
        request.current?.abort();
        request.current = null;
        setPage((previous) => ({ ...previous, pending: null }));
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      request.current?.abort();
      request.current = null;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);

  async function more() {
    const cursor = currentPage.nextCursor;
    if (!cursor || request.current || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    request.current = controller;
    setPage((previous) => ({ ...previous, pending: "more" }));
    try {
      const data = await readTournamentList(game, cursor, controller.signal);
      if (controller.signal.aborted) return;
      const seenCursors = new Set([...consumedCursors.current, cursor]);
      checkPage(game, data.tournaments, data.nextCursor, seenCursors);
      consumedCursors.current = seenCursors;
      pageCount.current++;
      setPage((previous) => ({
        game,
        tournaments: [
          ...new Map(
            [...previous.tournaments, ...data.tournaments].map((tournament) => [
              tournament.id,
              tournament,
            ]),
          ).values(),
        ],
        nextCursor: data.nextCursor,
        loaded: true,
        pending: null,
        error: null,
      }));
    } catch {
      if (!controller.signal.aborted)
        setPage((previous) => ({
          ...previous,
          pending: null,
          error: "続きの大会一覧を取得できませんでした。",
        }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  return { ...currentPage, refresh, more };
}
