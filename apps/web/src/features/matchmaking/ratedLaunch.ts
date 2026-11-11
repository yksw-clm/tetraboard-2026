import type { RatedMatchmakingGame } from "@tetraboard/protocol";

export const ratedLaunchSeenKey = "tetraboard:rated-launch:seen";
export const ratedLaunchGames: readonly RatedMatchmakingGame[] = [
  "four-shogi",
  "four-reversi",
  "shogi",
  "reversi",
];

export function ratedLaunchSeen(): boolean {
  try {
    return localStorage.getItem(ratedLaunchSeenKey) === "1";
  } catch {
    return true;
  }
}

export function claimRatedLaunch(): boolean {
  try {
    if (ratedLaunchSeen()) return false;
    localStorage.setItem(ratedLaunchSeenKey, "1");
    return true;
  } catch {
    return false;
  }
}

export function hasRatedLaunchIntent(search: string, state: unknown): boolean {
  const query = new URLSearchParams(search);
  if (query.get("matchmaking") === "1" || query.has("guestMerge")) return true;
  if (!state || typeof state !== "object") return false;
  return ["roomEntryIntent", "registrationReturn", "matchmakingRejoin"].some((key) =>
    Boolean(Reflect.get(state, key)),
  );
}
