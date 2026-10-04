import {
  getMatchContract,
  isFourShogiMatch,
  isFourReversiMatch,
  assertNever,
  type GameId,
  type MatchFor,
} from "@tetraboard/protocol";
import { redirect, type LoaderFunctionArgs } from "react-router";
import type { FourShogiReplayFrame } from "./fourShogiReplay";

export type MatchReplayDataFor<G extends GameId> = {
  game: G;
  match: MatchFor<G>;
} & (G extends "four-shogi" ? { frames: FourShogiReplayFrame[] } : { frames?: never });
export type MatchReplayData = { [G in GameId]: MatchReplayDataFor<G> }[GameId];
export const replayLoaders = {
  "four-reversi": async (
    match: MatchFor<"four-reversi">,
    _signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"four-reversi">> => ({ game: "four-reversi", match }),
  "four-shogi": async (
    match: MatchFor<"four-shogi">,
    signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"four-shogi">> => {
    const { fetchFourShogiMatchReplay } = await import("./fourShogiMatchReplay");
    return { game: "four-shogi", match, frames: await fetchFourShogiMatchReplay(match, signal) };
  },
} satisfies {
  [G in GameId]: (match: MatchFor<G>, signal: AbortSignal) => Promise<MatchReplayDataFor<G>>;
};

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
    if (isFourReversiMatch(match))
      return await replayLoaders["four-reversi"](match, request.signal);
    if (isFourShogiMatch(match)) return await replayLoaders["four-shogi"](match, request.signal);
    return assertNever(match);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof Response) {
      if (error.status === 401) throw redirect("/login");
      throw error;
    }
    throw new Response(null, { status: 503 });
  }
}
