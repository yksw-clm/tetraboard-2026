import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest } from "./api";
import { useAdminData } from "./useAdminData";

export function useAdminPages<T extends { nextCursor: string | null }>(
  url: string,
  parse: (body: unknown) => T,
) {
  const initial = useAdminData(url, parse);
  const [extra, setExtra] = useState<T[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; status?: number } | null>(null);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  const denied = [401, 403].includes(failure?.status ?? initial.status ?? 0);
  const pages = initial.data && !denied ? [initial.data, ...extra] : [];
  const cursor = pages.at(-1)?.nextCursor;
  async function more() {
    if (!cursor || lock.current || denied) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const page = parse(
        await adminRequest(
          `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
          controller.signal,
        ),
      );
      if (!controller.signal.aborted) setExtra((old) => [...old, page]);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const status = cause instanceof AdminApiError ? cause.status : undefined;
        setFailure({
          message: cause instanceof Error ? cause.message : "追加取得できませんでした。",
          status,
        });
        if ([401, 403].includes(status ?? 0)) {
          initial.discard();
          setExtra([]);
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  function refresh() {
    if (denied) return;
    request.current?.abort();
    lock.current = false;
    setBusy(false);
    setExtra([]);
    setFailure(null);
    initial.refresh();
  }
  return {
    pages,
    denied,
    loading: initial.loading,
    loadingMore: busy,
    error: failure?.message ?? initial.error,
    status: failure?.status ?? initial.status,
    cursor,
    more,
    refresh,
  };
}
