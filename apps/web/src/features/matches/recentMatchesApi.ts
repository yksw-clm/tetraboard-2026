import { listPublicMatchesContract, type GameId } from "@tetraboard/protocol";

export async function fetchRecentMatches(game: GameId, signal: AbortSignal) {
  const response = await fetch(
    `/api${listPublicMatchesContract.path}?${new URLSearchParams({ game })}`,
    {
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw new Error("Recent matches request failed");
  const page = listPublicMatchesContract.response.parse(await response.json());
  if (page.matches.some((match) => match.game !== game))
    throw new Error("Recent match game mismatch");
  return page.matches;
}
