export const flowCookie = "tetraboard-2026.deletion-flow";
export const challengeCookie = "tetraboard-2026.deletion-challenge";
export const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;
