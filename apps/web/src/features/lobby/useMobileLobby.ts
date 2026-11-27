import { useSyncExternalStore } from "react";

const query = "(max-width: 767px)";
const matches = () => window.matchMedia(query).matches;

function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useMobileLobby() {
  return useSyncExternalStore(subscribe, matches, () => false);
}

export const lobbyTabParam = "lobbyTab";

export function readLobbyTab(search: string) {
  const tab = new URLSearchParams(search).get(lobbyTabParam);
  return tab === "rankings" || tab === "tournaments" ? tab : "play";
}
