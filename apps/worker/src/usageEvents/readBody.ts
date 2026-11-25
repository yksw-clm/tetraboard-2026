export async function readBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBodyBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(maxBodyBytes);
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.length > bytes.length) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, length);
      length += chunk.value.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
