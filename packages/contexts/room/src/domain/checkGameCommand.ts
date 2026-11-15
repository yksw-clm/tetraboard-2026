export type GameCommandRejection =
  | "game_not_started"
  | "game_finished"
  | "unauthorized"
  | "stale_position"
  | "time_expired"
  | "already_eliminated"
  | "not_your_turn";

export interface GameCommandInput<Seat extends string> {
  operation: "play" | "resign";
  status: "waiting" | "playing";
  hasLastRound: boolean;
  seat: Seat | null;
  eliminatedSeats: readonly Seat[];
  turn: Seat | null;
  positionMatches: boolean;
  clockExpired: boolean;
  requiresTurn?: boolean;
}

export function checkGameCommand<Seat extends string>(
  input: GameCommandInput<Seat>,
): GameCommandRejection | null {
  if (input.status === "waiting") return input.hasLastRound ? "game_finished" : "game_not_started";
  if (input.seat === null) return "unauthorized";
  if (input.operation === "play" && !input.positionMatches) return "stale_position";
  if (input.clockExpired) return "time_expired";
  if (input.requiresTurn === false) return null;
  if (input.eliminatedSeats.includes(input.seat)) return "already_eliminated";
  if (input.turn !== input.seat) return "not_your_turn";
  return null;
}
