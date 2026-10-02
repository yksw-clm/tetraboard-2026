import { createInitialState, sides, type Side, type FourShogiState } from "@tetraboard/four-shogi";
import { type FourShogiPublicState, type FourShogiRoom } from "@tetraboard/protocol";
import { orderedSeats, seatPositions } from "./roomPresentation";

import { clockPresentation } from "./roomClockPresentation";

export const shogiSideNames: Record<Side, string> = {
  south: "南",
  west: "西",
  north: "北",
  east: "東",
};
export const shogiEliminationLabels = {
  resigned: "投了",
  left: "退室",
  timeout: "時間切れ",
  disconnected: "通信切れ",
  checkmate: "詰み",
  no_legal_actions: "合法手なし",
} as const;

export function displayShogiGameForRoom(
  room: FourShogiRoom,
): FourShogiPublicState | FourShogiState {
  if (room.status === "playing") return room.game;
  if (room.lastRound !== null) return room.lastRound.game;
  return createInitialState({
    mode: room.settings.mode,
    players: {
      south: "preview-south",
      west: "preview-west",
      north: "preview-north",
      east: "preview-east",
    },
    threePlayerAttackProhibited: room.settings.threePlayerAttackProhibited,
  });
}

export function shogiViewerSide(room: FourShogiRoom, selfId: string | undefined): Side {
  if (selfId === undefined) return "south";
  if (room.status === "playing")
    return room.players.find((player) => player.id === selfId)?.side ?? "south";
  return room.lastRound?.players.find((player) => player.id === selfId)?.side ?? "south";
}

export function shogiCardPosition(side: Side, viewerSide: Side) {
  return seatPositions[(sides.indexOf(side) - sides.indexOf(viewerSide) + 4) % 4];
}

export function shogiRoomSeats(room: FourShogiRoom, selfId: string | undefined) {
  if (room.status === "playing") {
    return Object.fromEntries(
      sides.map((side) => [side, room.players.find((player) => player.side === side) ?? null]),
    ) as Record<Side, FourShogiRoom["players"][number] | null>;
  }
  const viewer = shogiViewerSide(room, selfId);
  const seats = orderedSeats(room, selfId);
  return Object.fromEntries(
    sides.map((side) => [side, seats[(sides.indexOf(side) - sides.indexOf(viewer) + 4) % 4]]),
  ) as Record<Side, FourShogiRoom["players"][number] | null>;
}

export function shogiPlayerClock(room: FourShogiRoom, side: Side | null, serverNowMs: number) {
  if (room.status === "playing" && side !== null) {
    if (room.game.eliminations.some((entry) => entry.side === side)) return null;
    return clockPresentation({
      timeControl: room.settings.timeControl,
      remainingMainMs: room.clock.remainingMainMs[side],
      turnStartedAt: room.clock.turnStartedAt,
      turnExpiresAt: room.clock.turnExpiresAt,
      isTurn: room.game.turn === side,
      serverNowMs,
    });
  }
  return clockPresentation({ timeControl: room.settings.timeControl, serverNowMs });
}

export function shogiPlayerRank(game: FourShogiPublicState, side: Side) {
  const elimination = game.eliminations.find((entry) => entry.side === side);
  const standing =
    game.status === "finished" && game.result.mode === "singles"
      ? game.result.standings.find((entry) => entry.side === side)
      : null;
  const rank = standing?.rank ?? elimination?.rank;
  if (rank != null)
    return {
      rank,
      label: `${rank}位${elimination ? `（${shogiEliminationLabels[elimination.reason]}）` : ""}`,
    };
  if (elimination)
    return { rank: 4, label: `脱落（${shogiEliminationLabels[elimination.reason]}）` };
  return null;
}

export function shogiReplayPlayerRank(
  room: FourShogiRoom,
  game: FourShogiPublicState,
  playerId: string | undefined,
) {
  const side = room.lastRound?.players.find((entry) => entry.id === playerId)?.side;
  return side ? shogiPlayerRank(game, side) : null;
}
