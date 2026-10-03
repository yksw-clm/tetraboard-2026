import { useEffect, useState } from "react";
import { AdminApiError, adminRequest } from "./api";
export function useAdminData<T>(url: string, parse: (body: unknown) => T) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    url: string;
    data: T | null;
    loading: boolean;
    error: string | null;
    status?: number;
  }>({ url, data: null, loading: true, error: null });
  useEffect(() => {
    const controller = new AbortController();
    // リクエスト先が変わった際は、以前の条件のデータを表示しません。
    // eslint-disable-next-line react/set-state-in-effect
    setState((old) => ({
      url,
      data: old.url === url ? old.data : null,
      loading: true,
      error: null,
    }));
    void adminRequest(url, controller.signal)
      .then(parse)
      .then((data) => {
        if (!controller.signal.aborted) setState({ url, data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState((old) => ({
            url,
            data:
              error instanceof AdminApiError && [401, 403].includes(error.status) ? null : old.data,
            loading: false,
            error: error instanceof Error ? error.message : "取得できません。",
            status: error instanceof AdminApiError ? error.status : undefined,
          }));
      });
    return () => controller.abort();
  }, [url, parse, revision]);
  return {
    ...(state.url === url
      ? state
      : { url, data: null, loading: true, error: null, status: undefined }),
    refresh: () => setRevision((old) => old + 1),
  };
}
