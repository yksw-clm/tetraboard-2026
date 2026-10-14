import { useCallback, useEffect, useRef, useState } from "react";
import { lobbyRoomsSchema, type LobbyRoom } from "@tetraboard/protocol/general-lobby";
import { lobbyRequest } from "./generalLobbyApi";
export type CapacityFilter = "all" | 2 | 4;
export function useGeneralLobbyRooms() {
  const [capacity, setCapacity] = useState<CapacityFilter>("all");
  const [page, setPage] = useState({
    rooms: [] as LobbyRoom[],
    nextCursor: null as string | null,
    loading: true,
    loaded: false,
    error: null as string | null,
    pendingSource: null as string | null,
  });
  const request = useRef<AbortController | null>(null),
    pages = useRef(1);
  const refresh = useCallback(
    async (source: string | null = null, more = false) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setPage((p) => ({ ...p, loading: true, pendingSource: source }));
      try {
        let cursor: string | null = more ? page.nextCursor : null;
        const collected: LobbyRoom[] = [];
        for (let i = 0; i < (more ? 1 : pages.current); i++) {
          const query = new URLSearchParams();
          if (capacity !== "all") query.set("capacity", String(capacity));
          if (cursor) query.set("cursor", cursor);
          const result = await lobbyRequest(
            `/lobby/rooms?${query}`,
            lobbyRoomsSchema,
            controller.signal,
          );
          collected.push(...result.rooms);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (controller.signal.aborted) return;
        if (more) pages.current++;
        setPage((p) => ({
          rooms: [...(more ? p.rooms : []), ...collected].filter(
            (v, i, a) => a.findIndex((r) => r.id === v.id) === i,
          ),
          nextCursor: cursor,
          loading: false,
          loaded: true,
          error: null,
          pendingSource: null,
        }));
      } catch (error) {
        if (!controller.signal.aborted)
          setPage((p) => ({
            ...p,
            loading: false,
            loaded: true,
            pendingSource: null,
            error: error instanceof Error ? error.message : "一覧を取得できませんでした。",
          }));
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [capacity, page.nextCursor],
  );
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const timer = setTimeout(() => void refreshRef.current(), 0);
    const visible = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
      else {
        request.current?.abort();
        request.current = null;
      }
    };
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refreshRef.current();
    }, 10000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      request.current?.abort();
      request.current = null;
    };
  }, [capacity]);
  function changeCapacity(value: CapacityFilter) {
    if (value === capacity) return;
    request.current?.abort();
    request.current = null;
    pages.current = 1;
    setPage({
      rooms: [],
      nextCursor: null,
      loading: true,
      loaded: false,
      error: null,
      pendingSource: null,
    });
    setCapacity(value);
  }
  return {
    ...page,
    capacity,
    changeCapacity,
    refresh: () => refresh("refresh"),
    loadMore: () => refresh("more", true),
  };
}
