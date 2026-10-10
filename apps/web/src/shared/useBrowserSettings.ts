import { useSyncExternalStore } from "react";
import { browserSettings } from "./browserSettings";

export function useBrowserSettings() {
  return useSyncExternalStore(browserSettings.subscribe, browserSettings.getSnapshot);
}
