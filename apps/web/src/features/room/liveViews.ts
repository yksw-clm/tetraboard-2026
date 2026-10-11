import { lazy, type ComponentType } from "react";
import type { GameId } from "@tetraboard/protocol";
import type { RoomLoaderDataFor } from "./roomLoader";
export type LivePropsFor<G extends GameId> = {
  initialRoom: RoomLoaderDataFor<G>["room"];
  initialMembership: RoomLoaderDataFor<G>["membership"];
  initialPresence: RoomLoaderDataFor<G>["presence"];
  initialServerNowMs: number;
  invited: boolean;
  initialFormationAnalysisSupported?: boolean;
};
export const liveViews = {
  "four-gomoku": lazy(() => import("./FourGomokuRoomDetail")),
  gomoku: lazy(() => import("./GomokuRoomDetail")),
  shogi: lazy(() => import("./ShogiRoomDetail")),
  reversi: lazy(() => import("./ReversiRoomDetail")),
  "four-reversi": lazy(() => import("./FourReversiRoomDetail")),
  "four-shogi": lazy(() => import("./FourShogiRoomDetail")),
} satisfies { [G in GameId]: ComponentType<LivePropsFor<G>> };
