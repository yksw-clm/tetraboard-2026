export const browserSettingsKey = "tetraboard:settings:v1";
export type BrowserSettings = { soundEnabled: boolean; stampsVisible: boolean };
export type BrowserSettingsSnapshot = BrowserSettings & { storageError: boolean };
const defaults: BrowserSettings = { soundEnabled: true, stampsVisible: true };

export function parseBrowserSettings(value: string | null): BrowserSettings {
  try {
    const parsed: unknown = value === null ? null : JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const fields = parsed as Record<string, unknown>;
    return {
      soundEnabled: typeof fields.soundEnabled === "boolean" ? fields.soundEnabled : true,
      stampsVisible: typeof fields.stampsVisible === "boolean" ? fields.stampsVisible : true,
    };
  } catch {
    return defaults;
  }
}

/** 未保存の変更をページ存続中に保ち、復帰時の古い保存値では取り消しません。 */
export class BrowserSettingsStore {
  private snapshot: BrowserSettingsSnapshot;
  private unsaved: Partial<BrowserSettings> = {};
  private listeners = new Set<() => void>();
  private readonly storage: () => Pick<Storage, "getItem" | "setItem">;

  constructor(storage: () => Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
    this.snapshot = this.read();
  }

  getSnapshot = (): BrowserSettingsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private read(): BrowserSettingsSnapshot {
    try {
      return {
        ...parseBrowserSettings(this.storage().getItem(browserSettingsKey)),
        storageError: false,
      };
    } catch {
      return { ...defaults, storageError: true };
    }
  }

  private publish(next: BrowserSettingsSnapshot): void {
    if (
      next.soundEnabled === this.snapshot.soundEnabled &&
      next.stampsVisible === this.snapshot.stampsVisible &&
      next.storageError === this.snapshot.storageError
    )
      return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  update(change: Partial<BrowserSettings>): void {
    const stored = this.read();
    const next = {
      soundEnabled: stored.storageError ? this.snapshot.soundEnabled : stored.soundEnabled,
      stampsVisible: stored.storageError ? this.snapshot.stampsVisible : stored.stampsVisible,
      ...this.unsaved,
      ...change,
    };
    this.unsaved = { ...this.unsaved, ...change };
    let storageError = false;
    try {
      this.storage().setItem(browserSettingsKey, JSON.stringify(next));
      this.unsaved = {};
    } catch {
      storageError = true;
    }
    this.publish({ ...next, storageError });
  }

  sync(value?: string | null): void {
    const stored =
      value === undefined ? this.read() : { ...parseBrowserSettings(value), storageError: false };
    this.publish({
      ...(stored.storageError ? this.snapshot : stored),
      ...this.unsaved,
      storageError: stored.storageError || Object.keys(this.unsaved).length > 0,
    });
  }
}

export const browserSettings = new BrowserSettingsStore(() => localStorage);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== browserSettingsKey && event.key !== null) return;
    try {
      if (event.storageArea !== null && event.storageArea !== localStorage) return;
      browserSettings.sync(event.newValue);
    } catch {
      browserSettings.sync();
    }
  });
  window.addEventListener("pageshow", () => browserSettings.sync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") browserSettings.sync();
  });
}
