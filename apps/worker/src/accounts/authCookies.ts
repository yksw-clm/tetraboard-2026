export function responseCookies(request: Request, response: Response) {
  const cookies = new Map(
    (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        const i = v.indexOf("=");
        return [v.slice(0, i), v.slice(i + 1)] as const;
      }),
  );
  for (const v of response.headers.getSetCookie()) {
    const pair = v.split(";")[0];
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const headers = new Headers(request.headers);
  headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  return headers;
}
