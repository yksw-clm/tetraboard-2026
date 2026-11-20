import { useSyncExternalStore } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";
const readReducedMotion = () => window.matchMedia(motionQuery).matches;

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => true);
}
