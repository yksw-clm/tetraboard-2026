import { useSyncExternalStore } from "react";
const desktopQuery = "(min-width: 1280px)";
function subscribeDesktop(callback: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const readDesktop = () => window.matchMedia(desktopQuery).matches;
export const useRoomDesktop = () =>
  useSyncExternalStore(subscribeDesktop, readDesktop, () => false);
