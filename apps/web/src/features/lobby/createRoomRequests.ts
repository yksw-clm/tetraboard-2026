import type { CreateRoomRequest, GameId } from "@tetraboard/protocol";
type Input = Omit<CreateRoomRequest, "game">;
export type CreateRoomRequests = {
  [G in GameId]: (
    input: Input,
  ) => Omit<CreateRoomRequest, "game"> & (G extends "four-reversi" ? { game?: G } : { game: G });
};
export const createRoomRequests = {
  gomoku: ({ mode: _mode, threePlayerAttackProhibited: _setting, ...input }: Input) => ({
    ...input,
    game: "gomoku",
  }),
  shogi: ({
    mode: _mode,
    threePlayerAttackProhibited: _setting,
    forbiddenRules: _forbidden,
    ...input
  }: Input) => ({
    ...input,
    game: "shogi" as const,
  }),
  reversi: ({
    mode: _mode,
    threePlayerAttackProhibited: _setting,
    forbiddenRules: _forbidden,
    ...input
  }: Input) => ({
    ...input,
    game: "reversi",
  }),
  "four-reversi": ({
    threePlayerAttackProhibited: _setting,
    forbiddenRules: _forbidden,
    ...input
  }: Input) => input,
  "four-shogi": ({ forbiddenRules: _forbidden, ...input }: Input) => ({
    ...input,
    game: "four-shogi",
  }),
} satisfies CreateRoomRequests;
