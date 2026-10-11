import { afterEach, beforeEach } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { browserSettings } from "../src/shared/browserSettings";

const roots = new Set<Root>();
const mounted = new WeakMap<HTMLElement, Root>();
export async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
export function renderHook<P, T>(
  hook: (props: P) => T,
  props: NoInfer<P>,
  wrap: (child: ReactNode) => ReactNode = (child) => child,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  let result: T;
  function Probe({ input }: { input: P }) {
    result = hook(input);
    return null;
  }
  function render(input: P) {
    act(() => root.render(wrap(createElement(Probe, { input }))));
  }
  render(props);
  return {
    get current() {
      return result!;
    },
    rerender: render,
    unmount() {
      act(() => root.unmount());
      roots.delete(root);
      container.remove();
    },
  };
}
export function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  mounted.set(container, root);
  act(() => root.render(node));
  return container;
}
export { act };

export class Clock {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; callback: () => void; interval: number }>();
  private restores: (() => void)[] = [];
  install() {
    const replace = (object: object, key: string, value: unknown) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, { configurable: true, writable: true, value });
      this.restores.push(() =>
        descriptor
          ? Object.defineProperty(object, key, descriptor)
          : Reflect.deleteProperty(object, key),
      );
    };
    const schedule = (callback: () => void, delay = 0, interval = 0) => {
      const id = this.next++;
      this.timers.set(id, { at: this.now + delay, callback, interval });
      return id;
    };
    for (const object of [globalThis, window]) {
      replace(object, "setTimeout", (fn: () => void, delay = 0) => schedule(fn, delay));
      replace(object, "setInterval", (fn: () => void, delay = 0) => schedule(fn, delay, delay));
      replace(object, "clearTimeout", (id: number) => this.timers.delete(id));
      replace(object, "clearInterval", (id: number) => this.timers.delete(id));
      replace(object, "requestAnimationFrame", (fn: (time: number) => void) =>
        schedule(() => fn(this.now), 16),
      );
      replace(object, "cancelAnimationFrame", (id: number) => this.timers.delete(id));
    }
    replace(performance, "now", () => this.now);
    replace(Date, "now", () => 1_790_899_200_000 + this.now);
  }
  advance(ms: number) {
    const end = this.now + ms;
    act(() => {
      let count = 0;
      while (true) {
        const next = [...this.timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        if (++count > 10000) throw new Error("Unbounded timer loop");
        const [id, timer] = next;
        this.now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else this.timers.delete(id);
        timer.callback();
      }
      this.now = end;
    });
  }
  restore() {
    for (const restore of this.restores.reverse()) restore();
    this.timers.clear();
  }
}
export let clock: Clock;
export type Request = {
  url: string;
  init: RequestInit;
  respond: (body: unknown, status?: number) => void;
  reject: (error?: unknown) => void;
};
export let requests: Request[];
beforeEach(() => {
  clock = new Clock();
  clock.install();
  requests = [];
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem("tetraboard:legal-version", "2026-10-12");
  browserSettings.sync();
  globalThis.fetch = ((url: string | URL | globalThis.Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({
        url: String(url),
        init,
        respond: (body, status = 200) =>
          resolve(
            new Response(status === 204 ? null : JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        reject,
      });
    })) as typeof fetch;
});
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.replaceChildren();
  clock.restore();
});

export function denyStorage() {
  const original = sessionStorage.setItem;
  Object.defineProperty(sessionStorage, "setItem", {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error("storage denied");
    },
  });
  return {
    mockRestore: () =>
      Object.defineProperty(sessionStorage, "setItem", {
        configurable: true,
        writable: true,
        value: original,
      }),
  };
}

export function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
export function press(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}

export function rerender(container: HTMLElement, node: ReactNode) {
  act(() => mounted.get(container)!.render(node));
}
