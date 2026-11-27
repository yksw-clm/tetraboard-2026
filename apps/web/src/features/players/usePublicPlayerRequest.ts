import { useEffect, useState } from "react";

export type PublicPlayerRequest<T> = { status: "loading" | "error" } | { status: "ready"; data: T };

export function usePublicPlayerRequest<T>(
  url: string | null,
  schema: { parse(value: unknown): T },
  onUnavailable?: () => void,
) {
  const [request, setRequest] = useState({ url });
  if (request.url !== url) setRequest({ url });
  const [response, setResponse] = useState<{
    request: typeof request;
    result: PublicPlayerRequest<T>;
  }>();
  useEffect(() => {
    const url = request.url;
    if (url === null) return;
    const controller = new AbortController();
    const complete = (result: PublicPlayerRequest<T>) => {
      if (!controller.signal.aborted) setResponse({ request, result });
    };
    void (async () => {
      try {
        const reply = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (reply.status === 404 && onUnavailable) onUnavailable();
        else if (!reply.ok) complete({ status: "error" });
        else complete({ status: "ready", data: schema.parse(await reply.json()) });
      } catch {
        complete({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [request, schema, onUnavailable]);
  const result: PublicPlayerRequest<T> =
    request.url === url && response?.request === request ? response.result : { status: "loading" };
  return { result, retry: () => setRequest({ url }) };
}
