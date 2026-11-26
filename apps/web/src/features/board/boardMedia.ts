import { getPublicMatchContract, tournamentDetailSchema } from "@tetraboard/protocol";
import { createContext, useContext, useEffect, useState } from "react";
import { tournamentPath } from "../tournaments/tournamentApi";
import { boardRequest } from "./boardApi";

function cacheRequest<K, T>(read: (key: K) => Promise<T>) {
  const requests = new Map<K, Promise<T>>();
  return (key: K) => {
    const cached = requests.get(key);
    if (cached) return cached;
    const request = read(key);
    requests.set(key, request);
    return request;
  };
}

export function createBoardMedia() {
  const match = cacheRequest(async (id: string) => {
    const response = await boardRequest(
      getPublicMatchContract.pathFor(id),
      { signal: AbortSignal.timeout(10_000) },
      "棋譜を表示できません。",
    );
    return getPublicMatchContract.response.parse(await response.json()).match;
  });
  return {
    match,
    tournament: cacheRequest(async (id: number) => {
      const response = await fetch(tournamentPath(id), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Tournament unavailable");
      return tournamentDetailSchema.parse(await response.json()).tournament.name;
    }),
    attachment: cacheRequest(async (id: string) => {
      const [record, { loadAttachmentFrames }, { BoardAttachmentBoard }] = await Promise.all([
        match(id),
        import("./boardAttachmentFrames"),
        import("./BoardAttachmentBoard"),
      ]);
      const frameAt = await loadAttachmentFrames(record, AbortSignal.timeout(10_000));
      return { frameAt, Board: BoardAttachmentBoard };
    }),
  };
}

export const BoardMediaContext = createContext<ReturnType<typeof createBoardMedia> | null>(null);

export function useBoardMedia() {
  const media = useContext(BoardMediaContext);
  if (!media) throw new Error("Missing board media provider");
  return media;
}

type Resource<T> = { status: "loading" } | { status: "failed" } | { status: "ready"; data: T };

export function useBoardMediaItem<K, T>(id: K, read: (id: K) => Promise<T>): Resource<T> {
  const [result, setResult] = useState<{ id: K; resource: Resource<T> } | null>(null);
  useEffect(() => {
    let active = true;
    void read(id).then(
      (data) => {
        if (active) setResult({ id, resource: { status: "ready", data } });
      },
      () => {
        if (active) setResult({ id, resource: { status: "failed" } });
      },
    );
    return () => {
      active = false;
    };
  }, [id, read]);
  return result && result.id === id ? result.resource : { status: "loading" };
}
