export const adminAccessDeniedEvent = "tetraboard:admin-access-denied";
function failure(status: number, message: string) {
  const error = new AdminApiError(status, message);
  if ((status === 401 || status === 403) && typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(adminAccessDeniedEvent, { detail: { status, message: error.message } }),
    );
  return error;
}
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
    throw failure(response.status, body?.message ?? "取得できません。再試行してください。");
  return body;
}
export async function adminMutation(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  input: unknown,
) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw failure(response.status, body?.message ?? "処理できませんでした。再試行してください。");
  return body;
}
