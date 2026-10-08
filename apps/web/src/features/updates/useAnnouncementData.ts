import { useEffect, useState } from "react";

export function useAnnouncementData<T>(url: string, parse: (body: unknown) => T) {
  const [revision, setRevision] = useState(0);
  const key = `${url}:${revision}`;
  const [state, setState] = useState<{
    key: string;
    url: string;
    data: T | null;
    error: string | null;
    status?: number;
  }>({ key: "", url: "", data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (!controller.signal.aborted)
            setState({
              key,
              url,
              data: null,
              error:
                response.status === 404
                  ? "お知らせが見つかりません。"
                  : "お知らせを取得できませんでした。",
              status: response.status,
            });
          return;
        }
        const data = parse(await response.json());
        if (!controller.signal.aborted) setState({ key, url, data, error: null });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ key, url, data: null, error: "お知らせを取得できませんでした。" });
      });
    return () => controller.abort();
  }, [url, key, parse]);
  return {
    ...(state.key === key
      ? state
      : {
          data: null,
          error: state.url === url ? state.error : null,
          status: state.url === url ? state.status : undefined,
        }),
    loading: state.key !== key,
    retry: () => setRevision((value) => value + 1),
  };
}
