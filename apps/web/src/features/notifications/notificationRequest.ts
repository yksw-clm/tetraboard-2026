/** 本人切替・タイムアウトのどちらでも通知だけを中止します。 */
export async function notificationRequest(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await fetch(`/api/${path}`, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) throw new Error("お知らせを取得・更新できませんでした。再試行してください。");
    const value: unknown = await response.json();
    if (controller.signal.aborted)
      throw new DOMException("Notification request canceled", "AbortError");
    return value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
