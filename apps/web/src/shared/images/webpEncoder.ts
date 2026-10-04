import encode, { init } from "@jsquash/webp/encode";
import wasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import simdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
let ready: Promise<unknown> | null = null;
export async function encodeWebp(pixels: ImageData): Promise<Blob> {
  if (!ready)
    ready = init({ locateFile: (path: string) => (path.includes("simd") ? simdWasmUrl : wasmUrl) });
  try {
    await ready;
  } catch (error) {
    ready = null;
    throw error;
  }
  return new Blob([await encode(pixels, { quality: 85 })], { type: "image/webp" });
}
