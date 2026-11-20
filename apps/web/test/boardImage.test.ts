import { boardImageUrl, preloadBoardImage } from "@tetraboard/shogi-ui/board-image";
import { expect, test } from "bun:test";

test("ブラウザーで盤面画像を高優先度で一度だけ先読みする", () => {
  preloadBoardImage();

  const requests: { src: string; fetchPriority: string; decoding: string }[] = [];
  class TestImage {
    fetchPriority = "auto";
    decoding = "auto";

    set src(src: string) {
      requests.push({ src, fetchPriority: this.fetchPriority, decoding: this.decoding });
    }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "Image", { configurable: true, value: TestImage });
  try {
    preloadBoardImage();
    preloadBoardImage();
    expect(requests).toEqual([{ src: boardImageUrl, fetchPriority: "high", decoding: "async" }]);
  } finally {
    Reflect.deleteProperty(globalThis, "Image");
    Reflect.deleteProperty(globalThis, "window");
  }
});
