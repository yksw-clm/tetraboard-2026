export const analyticsCookie = "tetraboard-2026.analytics";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function browserIdFromRequest(request: Request): string | null {
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${analyticsCookie}=`))
    ?.slice(analyticsCookie.length + 1);
  return cookie && uuidV4.test(cookie) ? cookie : null;
}
