import type { Room } from "@tetraboard/protocol";

export type BoardMotionContext = { scope: string; moveNumber: number };
export type BoardMotionFrame = {
  context?: BoardMotionContext | null;
  orientation: string | number;
  cells: readonly (readonly (string | null)[])[];
  destination: { x: number; y: number } | null;
  optimistic?: boolean;
  flip?: boolean;
};

export function roomBoardMotion(
  session: {
    room: Room;
    connection: string;
    authenticated: boolean;
    leaving: boolean;
    unavailable: string | null;
  },
  replay: { frame: unknown; index: number; frames: readonly unknown[] },
): BoardMotionContext | null {
  const { room } = session;
  if (
    !session.authenticated ||
    session.connection !== "接続済み" ||
    session.leaving ||
    session.unavailable !== null ||
    (replay.frame !== null &&
      (room.status === "playing" || replay.index !== replay.frames.length - 1))
  )
    return null;
  const lastRound = room.lastRound;
  const savedId = lastRound && ("roundId" in lastRound ? lastRound.roundId : lastRound.replay?.id);
  const roundId = "roundId" in room ? (room.roundId ?? savedId) : "four-reversi";
  const game = room.status === "playing" ? room.game : room.lastRound?.game;
  return roundId && game
    ? { scope: `${room.instanceId}:${roundId}`, moveNumber: game.moveNumber }
    : null;
}

export function boardMotionChanges(before: BoardMotionFrame, after: BoardMotionFrame) {
  const destination = after.destination;
  if (
    !before.context ||
    !after.context ||
    before.context.scope !== after.context.scope ||
    before.orientation !== after.orientation ||
    !destination
  )
    return [];
  const step = after.context.moveNumber - before.context.moveNumber;
  if (step !== 1 && !(step === 0 && after.optimistic)) return [];
  const { x, y } = destination;
  const placed = after.cells[y]?.[x];
  if (!placed || before.cells[y]?.[x] === placed) return [];
  const changes = [{ x, y, from: null as string | null, to: placed }];
  if (after.flip)
    after.cells.forEach((row, cy) =>
      row.forEach((to, cx) => {
        const from = before.cells[cy]?.[cx];
        if (from && to && from !== to) changes.push({ x: cx, y: cy, from, to });
      }),
    );
  return changes;
}
