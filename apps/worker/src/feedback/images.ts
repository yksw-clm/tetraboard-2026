// 本文の読み取り中にも上限を適用し、Content-Lengthの省略を許しても無制限に読みません。
export async function readLimitedBody(request: Pick<Request, "body">, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function validFeedbackImage(bytes: Uint8Array): boolean {
  const text = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
  if (
    bytes.length < 30 ||
    bytes.length > 1024 * 1024 ||
    text(0, 4) !== "RIFF" ||
    text(8, 12) !== "WEBP"
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return false;
  let imageCount = 0;
  let at = 12;
  for (; at + 8 <= bytes.length;) {
    const type = text(at, at + 4);
    const size = view.getUint32(at + 4, true);
    const data = at + 8;
    if (data + size > bytes.length || !["VP8 ", "VP8L", "VP8X", "ALPH"].includes(type))
      return false;
    if (type === "VP8X") {
      // EXIF・XMP・ICC・animationのフラグは受け付けません。
      if (size !== 10 || (bytes[data]! & 0x2e) !== 0) return false;
      const width = 1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16);
      const height = 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16);
      if (width > 1600 || height > 1600) return false;
    }
    if (type === "VP8 " || type === "VP8L") {
      let width: number, height: number;
      if (type === "VP8 ") {
        if (size < 10 || text(data + 3, data + 6) !== "\x9d\x01\x2a") return false;
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
      } else {
        if (size < 5 || bytes[data] !== 0x2f) return false;
        const bits = view.getUint32(data + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (width < 1 || height < 1 || width > 1600 || height > 1600 || ++imageCount !== 1)
        return false;
    }
    at = data + size + (size % 2);
  }
  return at === bytes.length && imageCount === 1;
}
