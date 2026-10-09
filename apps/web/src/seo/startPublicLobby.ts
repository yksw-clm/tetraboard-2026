import type { DataRouter } from "react-router";
import { preloadRecovery, preloadRecoveryMessage } from "../shared/preloadRecovery";

/** 遅延ルートの準備が済むまで、配信された紹介HTMLを残す。 */
export function startPublicLobby(root: HTMLElement, router: DataRouter, mount: () => void): void {
  if (!root.dataset.publicLobby) {
    mount();
    return;
  }
  const reloadLink = root.querySelector<HTMLAnchorElement>("[data-startup-reload]");
  if (reloadLink) {
    reloadLink.href = window.location.href;
    reloadLink.addEventListener("click", (event) => {
      event.preventDefault();
      preloadRecovery.reload();
    });
  }
  function ready(): boolean {
    if (!router.state.initialized) return false;
    if (router.state.errors) {
      const preloadError = Object.values(router.state.errors).some((error) =>
        preloadRecovery.isPreloadError(error),
      );
      const status = root.querySelector<HTMLElement>("[data-startup-status]");
      if (status) {
        status.setAttribute("role", "alert");
        status.textContent = preloadError
          ? preloadRecoveryMessage
          : "対局画面を読み込めませんでした。再読み込みしてください。";
      }
      if (preloadError) preloadRecovery.tryAutoReload();
    } else {
      delete root.dataset.publicLobby;
      mount();
    }
    return true;
  }
  if (ready()) return;
  const unsubscribe = router.subscribe(() => {
    if (ready()) unsubscribe();
  });
}
