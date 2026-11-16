import type {
  FourGomokuLastRound,
  FourShogiLastRound,
  GameId,
  GomokuLastRound,
  LastRound,
  ReversiLastRound,
  RoomFor,
  RoomSocketMessage,
  ShogiLastRound,
} from "@tetraboard/protocol";
export type ProgressError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
export type PlayingFor<G extends GameId> = Extract<RoomFor<G>, { status: "playing" }>;
export type WaitingFor<G extends GameId> = Extract<RoomFor<G>, { status: "waiting" }>;
interface ProgressTypes {
  "four-gomoku": { finished: FourGomokuLastRound["game"]; lastRound: FourGomokuLastRound };
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
