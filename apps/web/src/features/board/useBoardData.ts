import { useCallback, useEffect, useRef, useState } from "react";
import { BoardRequestError } from "./boardApi";

type ReadAction = "initial" | "refresh" | "more";
type ReadFailure = { source: ReadAction | "sync"; notFound: boolean };
type Pending = ReadAction | "retry" | "write";

function readFailure(source: ReadAction, error: unknown): ReadFailure {
  return { source, notFound: error instanceof BoardRequestError && error.status === 404 };
}

export function useBoardData<T>(readFirst: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState<Pending | null>("initial");
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  // 書き込み中に取得結果で投稿が上書きされたり、削除した投稿が再表示されたりするのを防ぎます。
  const active = useRef<AbortController | null>(null);

  const run = useCallback(
    async (source: Pending, operation: (signal: AbortSignal) => Promise<void>) => {
      if (active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setPending(source);
      try {
        await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      } finally {
        if (active.current === controller) {
          active.current = null;
          setPending(null);
        }
      }
    },
    [],
  );

  const replace = useCallback(
    async (signal: AbortSignal, source: ReadAction = "refresh", onSettled?: () => void) => {
      try {
        const next = await readFirst(signal);
        signal.throwIfAborted();
        setData(next);
        setFailure(null);
      } catch (error) {
        if (signal.reason?.name !== "AbortError") setFailure(readFailure(source, error));
      } finally {
        if (signal.reason?.name !== "AbortError") onSettled?.();
      }
    },
    [readFirst],
  );

  useEffect(() => {
    // 表示中の掲示板と閲覧者に対して初回の取得を行います。
    // eslint-disable-next-line react/set-state-in-effect
    void run("initial", (signal) => replace(signal, "initial"));
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [replace, run]);

  return {
    data,
    failure,
    pending,
    change(update: (current: T) => T) {
      setData((current) => (current ? update(current) : current));
    },
    refresh(retry = false, onSettled?: () => void) {
      return run(retry ? "retry" : "refresh", (signal) =>
        replace(signal, data ? "refresh" : "initial", onSettled),
      );
    },
    more(load: (signal: AbortSignal) => Promise<(current: T) => T>, retry = false) {
      return run(retry ? "retry" : "more", async (signal) => {
        try {
          const merge = await load(signal);
          signal.throwIfAborted();
          setData((current) => (current ? merge(current) : current));
          setFailure((previous) => (previous?.source === "sync" ? previous : null));
        } catch (error) {
          if (signal.reason?.name === "AbortError") return;
          const next = readFailure("more", error);
          setFailure((previous) =>
            previous?.source === "sync" && !next.notFound ? previous : next,
          );
        }
      });
    },
    syncFailed() {
      setFailure({ source: "sync", notFound: false });
    },
    clearSyncFailure() {
      setFailure((previous) => (previous?.source === "sync" ? null : previous));
    },
    retrySync(operation: (signal: AbortSignal) => Promise<void>) {
      return run("retry", operation);
    },
    write(operation: (signal: AbortSignal) => Promise<void>) {
      return run("write", operation);
    },
    replace,
  };
}

export type BoardWrite = ReturnType<typeof useBoardData>["write"];
