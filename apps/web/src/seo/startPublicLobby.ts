import type { DataRouter } from "react-router";

/** 遅延ルートの準備が済むまで、配信された紹介HTMLを残す。 */
export function startPublicLobby(root: HTMLElement, router: DataRouter, mount: () => void): void {
  if (!root.dataset.publicLobby) {
    mount();
    return;
  }
  function ready(): boolean {
    if (!router.state.initialized) return false;
    if (router.state.errors) {
      const status = root.querySelector<HTMLElement>("[data-startup-status]");
      if (status) {
        status.setAttribute("role", "alert");
        status.textContent = "対局画面を読み込めませんでした。再読み込みしてください。";
      }
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
