import { beforeEach, afterEach, mock, spyOn } from "bun:test";

// Control the conversion boundary. No image decoder, pixels or WASM is executed.
export let image: { width: number; height: number; close: () => void };
export let encoded: Blob;
export let draws: unknown[][];
export let decode: (file: Blob) => Promise<typeof image>;
export let closed: number;
mock.module("../src/shared/images/webpEncoder", () => ({ encodeWebp: async () => encoded }));
mock.module("../src/features/account/webpEncoder", () => ({ encodeWebp: async () => encoded }));
let restore: (() => void)[];
const original = globalThis.createImageBitmap;
beforeEach(() => {
  closed = 0;
  draws = [];
  image = {
    width: 2400,
    height: 1200,
    close: () => {
      closed++;
    },
  };
  encoded = new Blob(["webp"], { type: "image/webp" });
  decode = async () => image;
  globalThis.createImageBitmap = ((file: Blob) => decode(file)) as typeof createImageBitmap;
  const context = spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        drawImage: (...args: unknown[]) => draws.push(args),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(0),
        }),
      }) as never,
  );
  const blob = spyOn(window.HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback: BlobCallback) => callback(encoded),
  );
  restore = [() => context.mockRestore(), () => blob.mockRestore()];
});
afterEach(() => {
  restore.forEach((fn) => fn());
  globalThis.createImageBitmap = original;
});
export function setImage(width: number, height: number) {
  image.width = width;
  image.height = height;
}
export function setEncoded(blob: Blob) {
  encoded = blob;
}
export function holdImage() {
  let resolve!: (value: typeof image) => void;
  decode = () =>
    new Promise((r) => {
      resolve = r;
    });
  return () => resolve(image);
}
