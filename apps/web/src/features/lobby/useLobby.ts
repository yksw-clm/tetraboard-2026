import { listRoomsContract, type RoomPublicMetadata } from "@tetraboard/protocol";
import { useEffect, useRef, useState } from "react";

async function fetchLobby(cursor: string | null, signal: AbortSignal) {
  const path = cursor
    ? `${listRoomsContract.path}?cursor=${encodeURIComponent(cursor)}`
    : listRoomsContract.path;
  const response = await fetch(`/api${path}`, {
    method: listRoomsContract.method,
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Lobby request failed");
  return listRoomsContract.response.parse(await response.json());
}

export function useLobby() {
  const [rooms, setRooms] = useState<RoomPublicMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreLoaded, setMoreLoaded] = useState(false);
  const request = useRef<AbortController | null>(null);

  async function refresh(): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setMoreLoading(false);
    setLoading(true);
    try {
      const page = await fetchLobby(null, controller.signal);
      if (controller.signal.aborted) return;
      setRooms(page.rooms);
      setNextCursor(page.nextCursor);
      setMoreLoaded(false);
      setError(null);
    } catch {
      if (!controller.signal.aborted) setError("ロビーの一覧を取得できませんでした。");
    } finally {
      if (request.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !moreLoaded && !moreLoading) void refresh();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [moreLoaded, moreLoading]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loading || moreLoading) return;
    setMoreLoading(true);
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(false);
    try {
      const page = await fetchLobby(nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setRooms((current) => [
        ...current,
        ...page.rooms.filter((room) => !current.some((entry) => entry.id === room.id)),
      ]);
      setNextCursor(page.nextCursor);
      setMoreLoaded(true);
      setError(null);
    } catch {
      if (!controller.signal.aborted) setError("続きのルームを取得できませんでした。");
    } finally {
      if (request.current === controller) setMoreLoading(false);
    }
  }

  return { rooms, nextCursor, error, loading, moreLoading, refresh, loadMore };
}
