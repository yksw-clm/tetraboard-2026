import { lazy, type ComponentType } from "react";
import type { GameId } from "@tetraboard/protocol";
import type { MatchReplayDataFor } from "./matchReplayLoader";
export const replayViews = {
  "four-gomoku": lazy(() => import("./FourGomokuMatchReplayView")),
  gomoku: lazy(() => import("./GomokuMatchReplayView")),
  shogi: lazy(() => import("./ShogiMatchReplayView")),
  reversi: lazy(() => import("./ReversiMatchReplayView")),
  "four-reversi": lazy(() => import("./FourReversiMatchReplayView")),
  "four-shogi": lazy(() => import("./FourShogiMatchReplayView")),
} satisfies { [G in GameId]: ComponentType<Omit<MatchReplayDataFor<G>, "game">> };
