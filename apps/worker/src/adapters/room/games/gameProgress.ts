import type {
  FinishedProgress,
  LastRoundFor,
  PlayingFor,
  ProgressFor,
  RematchFor,
  WaitingFor,
} from "@tetraboard/context-room";
import type { GameId, RoomFor, RoomMembership } from "@tetraboard/protocol";
import { FourGomokuProgress } from "./four-gomoku/progress";
import { FourReversiProgress } from "./four-reversi/progress";
import { FourShogiProgress } from "./four-shogi/progress";
import { createGomokuProgress } from "./gomoku/progress";
import { ReversiProgress } from "./reversi/progress";
import { ShogiProgress } from "./shogi/progress";
export type {
  AnyProgress,
  FinishedFor,
  FinishedProgress,
  LastRoundFor,
  PlayingFor,
  ProgressError,
  ProgressFor,
  RematchFor,
  WaitingFor,
} from "@tetraboard/context-room";
export interface ProgressDependencies {
  storage: DurableObjectStorage;
  membership: (hash: string) => RoomMembership | null;
  accountId: (playerId: string) => string | null;
}
type Registration<G extends GameId> = {
  create: (dependencies: ProgressDependencies) => {
    start: (room: WaitingFor<G>) => { room: PlayingFor<G>; roundId: string; at: number };
    play: (
      room: RoomFor<G>,
      tokenHash: string,
      command: import("@tetraboard/protocol").GameActionCommandFor<G>,
    ) => ProgressFor<G>;
    resign: (room: RoomFor<G>, tokenHash: string) => ProgressFor<G>;
    cpu: (room: PlayingFor<G>, now: number) => ProgressFor<G>;
    finalize: (result: FinishedProgress<G>) => LastRoundFor<G>;
    waiting: (data: RematchFor<G>, players: RoomFor<G>["players"]) => WaitingFor<G>;
  };
};
export type GameProgressRegistration = { [G in GameId]: Registration<G> };

export const gameProgress = {
  "four-gomoku": {
    create: (dependencies: ProgressDependencies) => new FourGomokuProgress(dependencies),
  },
  gomoku: { create: createGomokuProgress },
  shogi: { create: (dependencies: ProgressDependencies) => new ShogiProgress(dependencies) },
  reversi: { create: (dependencies: ProgressDependencies) => new ReversiProgress(dependencies) },
  "four-reversi": {
    create: (dependencies: ProgressDependencies) => new FourReversiProgress(dependencies),
  },
  "four-shogi": {
    create: (dependencies: ProgressDependencies) => new FourShogiProgress(dependencies),
  },
} satisfies GameProgressRegistration;
export function unreachable(value: never): never {
  throw new Error(`Unknown game: ${String(value)}`);
}
