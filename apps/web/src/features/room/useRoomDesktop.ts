import { useSyncExternalStore } from "react";
const desktopQuery = "(min-width: 1280px)";
const mobileQuery = "(max-width: 767px)";
function subscribeToMedia(query: string, callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
const subscribeDesktop = (callback: () => void) => subscribeToMedia(desktopQuery, callback);
const subscribeMobile = (callback: () => void) => subscribeToMedia(mobileQuery, callback);
const readDesktop = () => window.matchMedia(desktopQuery).matches;
const readMobile = () => window.matchMedia(mobileQuery).matches;
export const useRoomDesktop = () =>
  useSyncExternalStore(subscribeDesktop, readDesktop, () => false);
export const useRoomMobile = () => useSyncExternalStore(subscribeMobile, readMobile, () => false);
