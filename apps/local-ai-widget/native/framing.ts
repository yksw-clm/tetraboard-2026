import { endianness } from "node:os";

const littleEndian = endianness() === "LE";
export function encodeMessage(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(body.length + 4);
  new DataView(frame.buffer).setUint32(0, body.length, littleEndian);
  frame.set(body, 4);
  return frame;
}

export class NativeFrames {
  private pending = new Uint8Array(0);
  push(chunk: Uint8Array): unknown[] {
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.length);
    const messages: unknown[] = [];
    let offset = 0;
    while (bytes.length - offset >= 4) {
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
        0,
        littleEndian,
      );
      if (size === 0 || size > 4096) throw Error("Native message size is invalid");
      if (bytes.length - offset < size + 4) break;
      messages.push(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(offset + 4, offset + 4 + size),
          ),
        ),
      );
      offset += size + 4;
    }
    this.pending = bytes.slice(offset);
    return messages;
  }
  finish() {
    if (this.pending.length) throw Error("Incomplete native message");
  }
}
