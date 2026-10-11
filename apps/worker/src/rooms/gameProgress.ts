import { GomokuProgress } from "./gomokuProgress";
import type { GomokuLastRound } from "@tetraboard/protocol";
import { ShogiProgress } from "./standardShogiProgress";
import type { ShogiLastRound } from "@tetraboard/protocol";
import type { ReversiLastRound } from "@tetraboard/protocol";
import { ReversiProgress } from "./reversiProgress";
import type {
  GameId,
  RoomFor,
  RoomMembership,
  RoomSocketMessage,
  LastRound,
  FourShogiLastRound,
} from "@tetraboard/protocol";
import { FourReversiProgress } from "./fourReversiProgress";
import { FourShogiProgress } from "./fourShogiProgress";
export type ProgressError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
export type PlayingFor<G extends GameId> = Extract<RoomFor<G>, { status: "playing" }>;
export type WaitingFor<G extends GameId> = Extract<RoomFor<G>, { status: "waiting" }>;
interface ProgressTypes {
  gomoku: { finished: GomokuLastRound["game"]; lastRound: GomokuLastRound };
  shogi: { finished: ShogiLastRound["game"]; lastRound: ShogiLastRound };
  reversi: { finished: ReversiLastRound["game"]; lastRound: ReversiLastRound };
  "four-reversi": { finished: LastRound["game"]; lastRound: LastRound };
  "four-shogi": { finished: FourShogiLastRound["game"]; lastRound: FourShogiLastRound };
}
export type FinishedFor<G extends GameId> = ProgressTypes[G]["finished"];
export type LastRoundFor<G extends GameId> = ProgressTypes[G]["lastRound"];
export type FinishedProgress<G extends GameId> = {
  kind: "finished";
  gameId: G;
  room: PlayingFor<G>;
  game: FinishedFor<G>;
  at: number;
};
export type ProgressFor<G extends GameId> =
  | { kind: "rejected"; error: ProgressError }
  | { kind: "unchanged"; gameId: G; room: RoomFor<G> }
  | { kind: "playing"; gameId: G; room: PlayingFor<G> }
  | FinishedProgress<G>;
export type AnyProgress = { [G in GameId]: ProgressFor<G> }[GameId];
export type RematchFor<G extends GameId> = {
  room: PlayingFor<G>;
  lastRound: LastRoundFor<G>;
  at: number;
};
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
  gomoku: { create: (dependencies: ProgressDependencies) => new GomokuProgress(dependencies) },
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
