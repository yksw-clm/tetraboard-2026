export type ShogiImageStatus = "idle" | "loading" | "ready" | "error";
type Entry = {
  status: ShogiImageStatus;
  image: HTMLImageElement;
  preparation: Promise<void>;
};

export function createShogiImageStore() {
  // デコードしたImageも保持し、画面内の移動や再戦で同じ画像を再利用します。
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  function notify(src: string) {
    for (const listener of listeners.get(src) ?? []) listener();
  }
  return {
    getStatus(src: string): ShogiImageStatus {
      return entries.get(src)?.status ?? "idle";
    },
    subscribe(src: string, listener: () => void) {
      const subscribers = listeners.get(src) ?? new Set<() => void>();
      listeners.set(src, subscribers);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(src);
      };
    },
    prepare(src: string): Promise<void> {
      const existing = entries.get(src);
      if (existing) return existing.preparation;
      const image = new Image();
      const entry: Entry = {
        status: "loading",
        image,
        preparation: Promise.resolve().then(async () => {
          try {
            image.src = src;
            await image.decode();
            entry.status = image.complete && image.naturalWidth > 0 ? "ready" : "error";
          } catch {
            entry.status = "error";
          }
          notify(src);
        }),
      };
      entries.set(src, entry);
      notify(src);
      return entry.preparation;
    },
  };
}
