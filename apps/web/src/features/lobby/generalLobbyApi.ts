export async function lobbyRequest<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result === "object" &&
        result &&
        "message" in result &&
        typeof result.message === "string"
        ? result.message
        : "処理できませんでした。再試行してください。",
    );
  return schema.parse(result);
}
