import type { Room } from "@tetraboard/protocol";
import type { SoundEffect } from "../../shared/soundPlayer";

export interface SoundGameState {
  phase: "waiting" | "playing" | "finished";
  roundId: string | null;
  moveNumber: number;
  lastMove: string | null;
}
export type RoomSoundEvent =
  | { type: "join"; instanceId: string; playerId: string }
  | { type: "sounds"; sounds: SoundEffect[] };

/** 接続ごとの履歴を保持し、Reactの描画・棋譜の表示には依存しません。 */
export class RoomSoundTracker<T extends Room> {
  private previous: T | null = null;
  private ownMove: { roundId: string | null; moveNumber: number; lastMove: string } | null = null;
  private readonly readGame: (room: T) => SoundGameState;

  constructor(readGame: (room: T) => SoundGameState) {
    this.readGame = readGame;
  }

  reset(): void {
    this.previous = null;
    this.clearOwnMove();
  }

  clearOwnMove(): void {
    this.ownMove = null;
  }

  baseline(room: T): void {
    this.previous = room;
    const game = this.readGame(room);
    if (
      game.phase !== "playing" ||
      this.ownMove?.roundId !== game.roundId ||
      this.ownMove.moveNumber <= game.moveNumber
    )
      this.clearOwnMove();
  }

  recordOwnMove(room: T, lastMove: string): void {
    const game = this.readGame(room);
    if (game.phase !== "playing") return;
    this.ownMove = { roundId: game.roundId, moveNumber: game.moveNumber + 1, lastMove };
  }

  observe(room: T, audible: boolean): RoomSoundEvent[] {
    const previous = this.previous;
    this.previous = room;
    if (!audible || previous === null || previous.instanceId !== room.instanceId) {
      this.clearOwnMove();
      return [];
    }
    const events: RoomSoundEvent[] = [];
    const ids = new Set(previous.players.map((player) => player.id));
    const added = room.players.filter((player) => !ids.has(player.id));
    for (const player of added) {
      if (player.kind === "human")
        events.push({ type: "join", instanceId: room.instanceId, playerId: player.id });
    }
    const sounds: SoundEffect[] = [];
    if (added.some((player) => player.kind === "cpu")) sounds.push("bot");
    const before = this.readGame(previous);
    const after = this.readGame(room);
    const started =
      after.phase === "playing" && (before.phase !== "playing" || before.roundId !== after.roundId);
    if (started) {
      this.clearOwnMove();
      sounds.push("start");
    } else if (
      before.phase === "playing" &&
      (after.phase === "playing" || after.phase === "finished") &&
      before.roundId === after.roundId &&
      after.moveNumber > before.moveNumber
    ) {
      const own = this.ownMove;
      if (
        own === null ||
        own.roundId !== after.roundId ||
        own.moveNumber !== after.moveNumber ||
        own.lastMove !== after.lastMove
      ) {
        sounds.push("put");
      }
      this.clearOwnMove();
    }
    if (
      before.phase === "playing" &&
      after.phase === "finished" &&
      before.roundId === after.roundId
    ) {
      sounds.push("end");
      this.clearOwnMove();
    }
    if (sounds.length > 0) events.push({ type: "sounds", sounds });
    return events;
  }
}
