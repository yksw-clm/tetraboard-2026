export class BadgeNotificationRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Badge notification request failed");
    this.status = status;
  }
}

export async function badgeNotificationRequest(
  operation: string,
  token: string,
  signal: AbortSignal,
  id?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await fetch(`/api/account/badge-notifications/${operation}`, {
      method: "POST",
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...(id ? { id } : {}) }),
    });
    if (!response.ok) throw new BadgeNotificationRequestError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
