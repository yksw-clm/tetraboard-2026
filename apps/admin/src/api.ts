export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function adminRequest(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new AdminApiError(
      response.status,
      body?.message ?? "取得できません。再試行してください。",
    );
  return body;
}
