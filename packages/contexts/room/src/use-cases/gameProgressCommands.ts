import type { EliminationReason } from "@tetraboard/game-contract";
import type { GameId } from "@tetraboard/protocol";
import { checkGameCommand } from "../domain";
import {
  readProgressState,
  type GameProgressSpec,
  type PreparedLeave,
  type ProgressGameTypes,
  type ProgressPlayingRoom,
  type ProgressRoom,
} from "./gameProgressSpec";

export type CommandPosition = { roundId: string; positionRevision: number };

export function checkProgressCommand<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  room: ProgressRoom<G, T>,
  tokenHash: string,
  operation: "play" | "resign",
  position: boolean | CommandPosition,
  action?: T["action"],
) {
  const { definition, inactiveSeats, isClockExpired, membership, now, seat } = spec;
  const member = membership(tokenHash);
  const player = room.players.find((p) => p.id === member?.playerId);
  const error = checkGameCommand({
    operation,
    status: room.status,
    hasLastRound: room.lastRound !== null,
    seat: player ? seat(player) : null,
    eliminatedSeats: room.status === "playing" ? inactiveSeats(room.game) : [],
    turn:
      room.status === "playing" ? definition.rules.getTurn(readProgressState(spec, room)) : null,
    positionMatches:
      typeof position === "boolean"
        ? position
        : room.status === "playing" &&
          position.roundId === room.roundId &&
          position.positionRevision === room.positionRevision,
    clockExpired: room.clock !== null && isClockExpired(room.clock, now()),
    requiresTurn: action === undefined ? true : (definition.rules.requiresTurn?.(action) ?? true),
  });
  return { error, player };
}

export function applyGameCommand<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  room: ProgressPlayingRoom<G, T>,
  seat: T["seat"],
  action: T["action"],
) {
  const { definition, store } = spec;
  const loaded = store.loadTransition?.(room, "play");
  const state = loaded ? loaded.state : readProgressState(spec, room);
  const result = loaded
    ? definition.rules.applyAction(state, seat, action, loaded.history)
    : definition.rules.applyAction(state, seat, action);
  return { result, state };
}

export function applyProgressElimination<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  room: ProgressPlayingRoom<G, T>,
  seat: T["seat"],
  reason: EliminationReason,
) {
  const { store, definition } = spec;
  const loaded = store.loadTransition?.(room, "eliminate");
  if (!loaded) return definition.rules.eliminateSeat(readProgressState(spec, room), seat, reason);
  return definition.rules.eliminateSeat(loaded.state, seat, reason, loaded.history);
}
