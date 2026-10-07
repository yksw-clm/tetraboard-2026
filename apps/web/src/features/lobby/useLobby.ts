import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import {
  listRoomsContract,
  previewRoomListSchema,
  type PreviewRoomMetadata,
} from "@tetraboard/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

async function fetchLobby(game: GameId, cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams();
  if (game !== defaultGameId) query.set("game", game);
  if (cursor !== null) query.set("cursor", cursor);
  query.set("profilePreview", "1");
  const path = `${listRoomsContract.path}${query.size > 0 ? `?${query}` : ""}`;
  let response = await fetch(`/api${path}`, {
    method: listRoomsContract.method,
    cache: "no-store",
    signal,
  });
  if (response.status === 400) {
    query.delete("profilePreview");
    response = await fetch(`/api${listRoomsContract.path}${query.size ? `?${query}` : ""}`, {
      cache: "no-store",
      signal,
    });
  }
  if (!response.ok) throw new Error("Lobby request failed");
  return previewRoomListSchema.parse(await response.json());
}

export function useLobby(game: GameId = defaultGameId) {
  const [rooms, setRooms] = useState<PreviewRoomMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialLoadCompletedGame, setInitialLoadCompletedGame] = useState<GameId | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreLoaded, setMoreLoaded] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(
    async (source: string | null = null): Promise<void> => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setMoreLoading(false);
      setPendingSource(source);
      setLoading(true);
      try {
        const page = await fetchLobby(game, null, controller.signal);
        if (controller.signal.aborted) return;
        setRooms(page.rooms.filter((room) => room.game === game));
        setNextCursor(page.nextCursor);
        setMoreLoaded(false);
        setError(null);
      } catch {
        if (!controller.signal.aborted) setError("ロビーの一覧を取得できませんでした。");
      } finally {
        if (request.current === controller) {
          request.current = null;
          if (!controller.signal.aborted) setInitialLoadCompletedGame(game);
          setLoading(false);
          setPendingSource(null);
        }
      }
    },
    [game],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !moreLoaded &&
        !moreLoading &&
        request.current === null
      )
        void refresh();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [refresh, moreLoaded, moreLoading]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loading || moreLoading) return;
    setMoreLoading(true);
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(false);
    try {
      const page = await fetchLobby(game, nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setRooms((current) => [
        ...current,
        ...page.rooms.filter(
          (room) => room.game === game && !current.some((entry) => entry.id === room.id),
        ),
      ]);
      setNextCursor(page.nextCursor);
      setMoreLoaded(true);
      setError(null);
    } catch {
      if (!controller.signal.aborted) setError("続きのルームを取得できませんでした。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setMoreLoading(false);
      }
    }
  }

  return {
    rooms,
    nextCursor,
    error,
    loading,
    isInitialLoading: initialLoadCompletedGame !== game,
    moreLoading,
    pendingSource,
    refresh,
    loadMore,
  };
}
