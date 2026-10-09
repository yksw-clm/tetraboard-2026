export const preloadRecoveryMessage =
  "画面を読み込めませんでした。アプリが更新された可能性があります。再読み込みしてください。";
export const unexpectedErrorMessage = "画面を表示できませんでした。再読み込みしてください。";

const autoReloadKey = "tetraboard:preload-recovery:auto-reloaded";

export function createPreloadRecovery({
  getStorage = () => window.sessionStorage,
  reload = () => window.location.reload(),
}: {
  getStorage?: () => Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
} = {}) {
  const errors = new Set<unknown>();
  let reloadRequested = false;

  return {
    listen(target: Window) {
      const listener = (event: VitePreloadErrorEvent) => errors.add(event.payload);
      target.addEventListener("vite:preloadError", listener);
      return () => target.removeEventListener("vite:preloadError", listener);
    },
    isPreloadError(error: unknown) {
      return errors.has(error);
    },
    tryAutoReload() {
      if (reloadRequested) return;
      try {
        const storage = getStorage();
        if (storage.getItem(autoReloadKey) !== null) return;
        // 保存できる場合だけ更新し、次の文書での更新ループを防ぎます。
        storage.setItem(autoReloadKey, "1");
      } catch {
        return;
      }
      reloadRequested = true;
      reload();
    },
    reload,
  };
}

export const preloadRecovery = createPreloadRecovery();
