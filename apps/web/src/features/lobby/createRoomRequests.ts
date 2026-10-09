import type { CreateRoomRequest, GameId } from "@tetraboard/protocol";
type Input = Omit<CreateRoomRequest, "game">;
export type CreateRoomRequests = {
  [G in GameId]: (
    input: Input,
  ) => Omit<CreateRoomRequest, "game"> & (G extends "four-reversi" ? { game?: G } : { game: G });
};
export const createRoomRequests = {
  reversi: ({ mode: _mode, threePlayerAttackProhibited: _setting, ...input }: Input) => ({
    ...input,
    game: "reversi",
  }),
  "four-reversi": ({ threePlayerAttackProhibited: _setting, ...input }: Input) => input,
  "four-shogi": (input: Input) => ({ ...input, game: "four-shogi" }),
} satisfies CreateRoomRequests;
