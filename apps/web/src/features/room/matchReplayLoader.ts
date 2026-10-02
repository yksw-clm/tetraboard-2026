import { getMatchContract, isFourShogiMatch, type MatchDetail } from "@tetraboard/protocol";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { fetchFourShogiMatchReplay } from "./fourShogiMatchReplay";
import { type FourShogiReplayFrame } from "./fourShogiReplay";

export type MatchReplayData = { match: MatchDetail; shogiFrames: FourShogiReplayFrame[] | null };

export async function matchReplayLoader({ params, request }: LoaderFunctionArgs) {
  const parsed = getMatchContract.params.safeParse(params);
  if (!parsed.success) throw new Response(null, { status: 400 });
  let response: Response;
  try {
    response = await fetch(`/api${getMatchContract.pathFor(parsed.data.matchId)}`, {
      credentials: "include",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw new Response(null, { status: 503 });
  }
  if (response.status === 401) throw redirect("/login");
  if (!response.ok) throw new Response(null, { status: response.status });
  try {
    const match = getMatchContract.response.parse(await response.json()).match;
    const shogiFrames = isFourShogiMatch(match)
      ? await fetchFourShogiMatchReplay(match, request.signal)
      : null;
    return { match, shogiFrames } satisfies MatchReplayData;
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof Response) {
      if (error.status === 401) throw redirect("/login");
      throw error;
    }
    throw new Response(null, { status: 503 });
  }
}
