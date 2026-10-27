import { useCallback, useEffect, useRef, useState } from "react";
import { lobbyRoomCardsSchema, type LobbyRoomCard } from "@tetraboard/protocol/general-lobby";
import type { GameId } from "@tetraboard/protocol/games";
import type { RoomMode } from "@tetraboard/protocol";
import { lobbyRequest } from "./generalLobbyApi";

export type CapacityFilter = "all" | 2 | 4;
export type ModeFilter = "all" | RoomMode;
type Page = {
  scope: string;
  rooms: LobbyRoomCard[];
  loading: boolean;
  loaded: boolean;
  hasData: boolean;
  error: string | null;
  pendingSource: string | null;
};
function emptyPage(scope: string): Page {
  return {
    scope,
    rooms: [],
    loading: true,
    loaded: false,
    hasData: false,
    error: null,
    pendingSource: null,
  };
}
function priority(room: LobbyRoomCard) {
  return room.status === "waiting" ? (room.openSeats > 0 ? 0 : 1) : 2;
}
export function useGeneralLobbyRooms(game?: GameId) {
  const [capacity, setCapacity] = useState<CapacityFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [joinable, setJoinable] = useState(false);
  const scope = `${game ?? "all"}:${capacity}`;
  const [page, setPage] = useState(() => emptyPage(scope));
  const currentPage = page.scope === scope ? page : emptyPage(scope);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (source: string | null = null) => {
      if (request.current || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      request.current = controller;
      setPage((previous) => ({
        ...(previous.scope === scope ? previous : emptyPage(scope)),
        loading: true,
        pendingSource: source,
      }));
      try {
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        const collected = new Map<string, LobbyRoomCard>();
        do {
          const query = new URLSearchParams({ view: "cards" });
          if (game) query.set("game", game);
          if (capacity !== "all") query.set("capacity", String(capacity));
          if (cursor) {
            seenCursors.add(cursor);
            query.set("cursor", cursor);
          }
          const result = await lobbyRequest(
            `/lobby/rooms?${query}`,
            lobbyRoomCardsSchema,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (
            result.rooms.some(
              (room) =>
                (game && room.game !== game) || (capacity !== "all" && room.capacity !== capacity),
            )
          )
            throw new Error("一覧の取得条件が一致しませんでした。もう一度お試しください。");
          for (const room of result.rooms) {
            const previous = collected.get(room.id);
            if (!previous || room.updatedAtMs >= previous.updatedAtMs) collected.set(room.id, room);
          }
          cursor = result.nextCursor;
          if (cursor && seenCursors.has(cursor))
            throw new Error("一覧を最後まで取得できませんでした。もう一度お試しください。");
        } while (cursor !== null);
        if (controller.signal.aborted) return;
        const rooms = [...collected.values()].sort(
          (a, b) =>
            priority(a) - priority(b) ||
            b.updatedAtMs - a.updatedAtMs ||
            Number(b.id) - Number(a.id),
        );
        setPage({
          scope,
          rooms,
          loading: false,
          loaded: true,
          hasData: true,
          error: null,
          pendingSource: null,
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setPage((previous) => ({
            ...(previous.scope === scope ? previous : emptyPage(scope)),
            loading: false,
            loaded: true,
            pendingSource: null,
            error:
              error instanceof Error && !(error instanceof TypeError) && error.name !== "ZodError"
                ? error.message
                : "一覧を取得できませんでした。",
          }));
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [game, capacity, scope],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
      else if (request.current) {
        request.current.abort();
        request.current = null;
        setPage((previous) => ({ ...previous, loading: false, pendingSource: null }));
      }
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);
  const rooms = currentPage.rooms.filter(
    (room) =>
      (modeFilter === "all" || room.mode === modeFilter) &&
      (!joinable || (room.status === "waiting" && room.openSeats > 0)),
  );
  return {
    rooms,
    totalCount: rooms.length,
    loading: currentPage.loading,
    loaded: currentPage.loaded,
    hasData: currentPage.hasData,
    error: currentPage.error,
    pendingSource: currentPage.pendingSource,
    game,
    capacity,
    modeFilter,
    joinable,
    changeCapacity(value: CapacityFilter) {
      if (value !== capacity) {
        request.current?.abort();
        request.current = null;
        setCapacity(value);
      }
    },
    changeMode: setModeFilter,
    changeJoinable: setJoinable,
    refresh: (source: string | null = "refresh") => refresh(source),
  };
}
