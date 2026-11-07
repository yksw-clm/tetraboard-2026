export function validToken(token: string | undefined): token is string {
  return token !== undefined && /^[\x21-\x7e]{32,256}$/.test(token);
}

export async function authorized(request: Request, token: string): Promise<boolean> {
  const supplied = request.headers.get("authorization") ?? "";
  if (supplied.length > 263) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all(
    [supplied, `Bearer ${token}`].map(
      async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    ),
  );
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual[i]! ^ expected[i]!;
  return difference === 0;
}
