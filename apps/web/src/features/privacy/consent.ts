import { useSyncExternalStore } from "react";
import { legalVersion } from "@tetraboard/protocol/privacy";
const key = "tetraboard:legal-version";
let memory = false;
const listeners = new Set<() => void>();
export function hasLocalConsent() {
  try {
    return localStorage.getItem(key) === legalVersion;
  } catch {
    return memory;
  }
}
export function rememberConsent() {
  memory = true;
  try {
    localStorage.setItem(key, legalVersion);
  } catch {
    /* 現在のタブで保持します。 */
  }
  for (const l of listeners) l();
}
export function forgetConsent() {
  memory = false;
  try {
    localStorage.removeItem(key);
  } catch {
    /* タブ内の同意を解除します。 */
  }
  for (const l of listeners) l();
}
export function useLocalConsent() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      window.addEventListener("storage", callback);
      return () => {
        listeners.delete(callback);
        window.removeEventListener("storage", callback);
      };
    },
    hasLocalConsent,
    () => false,
  );
}
