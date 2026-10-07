import { Window } from "happy-dom";

// Separate Bun process: pure engine/Worker tests never inherit this DOM.
const window = new Window({
  url: "https://tetraboard.test/",
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    disableIframePageLoading: true,
    enableImageFileLoading: false,
  },
});
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "CSS",
  "HTMLElement",
  "SVGElement",
  "HTMLCanvasElement",
  "Text",
  "NodeFilter",
  "PointerEvent",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLImageElement",
  "Image",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : Reflect.get(window, key),
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(document, "fonts", { value: new window.EventTarget() });
// Images stay pending unless a test controls the decoder boundary.
window.HTMLImageElement.prototype.decode = () => new Promise(() => {});
// Any accidental real network call fails immediately.
const unexpectedFetch = () => {
  throw new Error("Unexpected network request in DOM test");
};
globalThis.fetch = unexpectedFetch as unknown as typeof fetch;
window.fetch = unexpectedFetch;
class UnmockedWebSocket {
  static OPEN = 1;
  constructor() {
    throw new Error("Unexpected WebSocket connection in DOM test");
  }
}
for (const object of [globalThis, window])
  Object.defineProperty(object, "WebSocket", {
    configurable: true,
    writable: true,
    value: UnmockedWebSocket,
  });

// Install lifecycle hooks at preload scope so every test file gets fresh clocks/requests.
await import("../apps/web/test-dom/support");
