import { createContext, useContext, useEffect, useState, type RefObject } from "react";

function cacheRequest<K, T>(read: (key: K) => Promise<T>) {
  const requests = new Map<K, Promise<T>>();
  return (key: K) => {
    const cached = requests.get(key);
    if (cached) return cached;
    const request = read(key).catch((error: unknown) => {
      requests.delete(key);
      throw error;
    });
    requests.set(key, request);
    return request;
  };
}

const mediaRequestLimit = 3;

function createRequestQueue() {
  let active = 0;
  const waiting: (() => void)[] = [];
  return function schedule<T>(read: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      function start() {
        active++;
        void read()
          .then(resolve, reject)
          .finally(() => {
            active--;
            waiting.shift()?.();
          });
      }
      if (active < mediaRequestLimit) start();
      else waiting.push(start);
    });
  };
}

export function createBoardMedia(schedule = createRequestQueue()) {
  const controller = new AbortController();
  const enqueue = <T>(read: (signal: AbortSignal) => Promise<T>) =>
    schedule(async () => {
      controller.signal.throwIfAborted();
      return read(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    });
  const match = cacheRequest((id: string) =>
    enqueue(async (signal) => {
      const { readBoardMatch } = await import("./boardMediaRequests");
      return readBoardMatch(id, signal);
    }),
  );
  return {
    schedule,
    cancel: () => controller.abort(),
    match,
    tournament: cacheRequest((id: number) =>
      enqueue(async (signal) => {
        const { readBoardTournamentName } = await import("./boardMediaRequests");
        return readBoardTournamentName(id, signal);
      }),
    ),
    attachment: cacheRequest(async (id: string) => {
      const [record, { loadAttachmentFrames }, { BoardAttachmentBoard }] = await Promise.all([
        match(id),
        import("./boardAttachmentFrames"),
        import("./BoardAttachmentBoard"),
      ]);
      const frameAt = await enqueue((signal) => loadAttachmentFrames(record, signal));
      return { frameAt, Board: BoardAttachmentBoard };
    }),
  };
}

type BoardMedia = ReturnType<typeof createBoardMedia>;

export function refreshBoardMedia(media: BoardMedia) {
  // 更新前の取得と更新後の取得にも同じ同時実行数の上限を使います。
  media.cancel();
  return createBoardMedia(media.schedule);
}

export const BoardMediaContext = createContext<BoardMedia | null>(null);

export function useBoardMedia() {
  const media = useContext(BoardMediaContext);
  if (!media) throw new Error("Missing board media provider");
  return media;
}

export function useBoardMediaNear(ref: RefObject<HTMLElement | null>, enabled = true) {
  const media = useBoardMedia();
  const [nearbyMedia, setNearbyMedia] = useState<BoardMedia | null>(null);
  const nearby = nearbyMedia === media || typeof window.IntersectionObserver !== "function";
  useEffect(() => {
    const element = ref.current;
    if (!enabled || nearby || !element) return;
    let observing = true;
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (!observing || !entries.some((entry) => entry.isIntersecting)) return;
        observing = false;
        observer.disconnect();
        setNearbyMedia(media);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      if (observing) observer.disconnect();
      observing = false;
    };
  }, [enabled, media, nearby, ref]);
  return nearby;
}

type Resource<T> = { status: "loading" } | { status: "failed" } | { status: "ready"; data: T };

export function useBoardMediaItem<K, T>(
  id: K,
  read: (id: K) => Promise<T>,
  enabled = true,
): Resource<T> {
  const [result, setResult] = useState<{ id: K; read: typeof read; resource: Resource<T> } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void read(id).then(
      (data) => {
        if (active) setResult({ id, read, resource: { status: "ready", data } });
      },
      () => {
        if (active) setResult({ id, read, resource: { status: "failed" } });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, id, read]);
  return result && result.id === id && result.read === read
    ? result.resource
    : { status: "loading" };
}
