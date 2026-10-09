import type { ShogiReplayFrame } from "./standardShogiReplayV1";
import {
  getMatchContract,
  getPublicMatchContract,
  isFourShogiMatch,
  isReversiMatch,
  isShogiMatch,
  isFourReversiMatch,
  assertNever,
  type GameId,
  type ReplayMatch,
  type ReplayMatchFor,
} from "@tetraboard/protocol";
import { redirect, type LoaderFunctionArgs } from "react-router";
import type { FourShogiReplayFrame } from "./fourShogiReplay";
import { preloadRecovery } from "../../shared/preloadRecovery";

export type MatchReplayDataFor<G extends GameId> = {
  game: G;
  match: ReplayMatchFor<G>;
} & (G extends "four-shogi"
  ? { frames: FourShogiReplayFrame[] }
  : G extends "shogi"
    ? { frames: ShogiReplayFrame[] }
    : { frames?: never });
export type MatchReplayData = { [G in GameId]: MatchReplayDataFor<G> }[GameId];
export const replayLoaders = {
  shogi: async (
    match: ReplayMatchFor<"shogi">,
    signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"shogi">> => {
    const { fetchShogiMatchReplay } = await import("./standardShogiMatchReplay");
    return { game: "shogi", match, frames: await fetchShogiMatchReplay(match, signal) };
  },
  reversi: async (
    match: ReplayMatchFor<"reversi">,
    _signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"reversi">> => ({ game: "reversi", match }),
  "four-reversi": async (
    match: ReplayMatchFor<"four-reversi">,
    _signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"four-reversi">> => ({ game: "four-reversi", match }),
  "four-shogi": async (
    match: ReplayMatchFor<"four-shogi">,
    signal: AbortSignal,
  ): Promise<MatchReplayDataFor<"four-shogi">> => {
    const { fetchFourShogiMatchReplay } = await import("./fourShogiMatchReplay");
    return { game: "four-shogi", match, frames: await fetchFourShogiMatchReplay(match, signal) };
  },
} satisfies {
  [G in GameId]: (match: ReplayMatchFor<G>, signal: AbortSignal) => Promise<MatchReplayDataFor<G>>;
};

export const matchReplayLoader = (args: LoaderFunctionArgs) => loadMatchReplay(args, false);
export const publicMatchReplayLoader = (args: LoaderFunctionArgs) => loadMatchReplay(args, true);

async function loadMatchReplay({ params, request }: LoaderFunctionArgs, publicView: boolean) {
  const contract = publicView ? getPublicMatchContract : getMatchContract;
  const parsed = contract.params.safeParse(params);
  if (!parsed.success) throw new Response(null, { status: 400 });
  let response: Response;
  try {
    response = await fetch(`/api${contract.pathFor(parsed.data.matchId)}`, {
      credentials: "include",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw new Response(null, { status: 503 });
  }
  if (!publicView && response.status === 401) throw redirect("/login");
  if (!response.ok) throw new Response(null, { status: response.status });
  try {
    const match = parseMatch(await response.json(), publicView);
    if (isShogiMatch(match)) return await replayLoaders.shogi(match, request.signal);
    if (isReversiMatch(match)) return await replayLoaders.reversi(match, request.signal);
    if (isFourReversiMatch(match))
      return await replayLoaders["four-reversi"](match, request.signal);
    if (isFourShogiMatch(match)) return await replayLoaders["four-shogi"](match, request.signal);
    return assertNever(match);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (preloadRecovery.isPreloadError(error)) throw error;
    if (error instanceof Response) {
      if (!publicView && error.status === 401) throw redirect("/login");
      throw error;
    }
    throw new Response(null, { status: 503 });
  }
}

function parseMatch(value: unknown, publicView: boolean): ReplayMatch {
  return (publicView ? getPublicMatchContract : getMatchContract).response.parse(value).match;
}
