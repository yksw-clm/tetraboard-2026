import { lobbyMatchesSchema } from "@tetraboard/protocol/general-lobby";
import { listPublicMatchesContract, type GameId } from "@tetraboard/protocol";

export async function fetchRecentMatches(
  game: GameId | "all",
  signal: AbortSignal,
  humanOnly = false,
) {
  const query = new URLSearchParams(game === "all" ? {} : { game });
  if (humanOnly) query.set("humanOnly", "true");
  const response = await fetch(
    `/api${game === "all" ? "/lobby/matches" : listPublicMatchesContract.path}?${query}`,
    {
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw new Error("Recent matches request failed");
  const page = (game === "all" ? lobbyMatchesSchema : listPublicMatchesContract.response).parse(
    await response.json(),
  );
  signal.throwIfAborted();
  if (game !== "all" && page.matches.some((match) => match.game !== game))
    throw new Error("Recent match game mismatch");
  if (humanOnly && page.matches.some((match) => match.participants.some((p) => p.kind !== "human")))
    throw new Error("Recent match participant mismatch");
  return page.matches;
}
