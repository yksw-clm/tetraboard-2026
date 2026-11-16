import type { RoomEffect } from "@tetraboard/context-room";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import { sendCurrentMembership } from "../../durableObjects/gameRoom/socket/membership";

export function executeRoomEffect(runtime: RoomRuntime, effect: RoomEffect): void {
  switch (effect.type) {
    case "broadcastRoom":
      return broadcastRoom(runtime, effect.room);
    case "closeSockets":
      return closeSockets(runtime, effect.tokenHash);
    case "sendMembership":
      return sendCurrentMembership(runtime, effect.tokenHash);
    case "chatChanged":
      runtime.chat.dirty = true;
      return;
    case "usage":
      runtime.usageEvents.writer().write(effect.event);
      return;
  }
}

// 入れ子の transaction でも、最も外側の確定前には効果を実行しません。
export class TransactionRoomEffects {
  private pending: RoomEffect[] | null = null;
  constructor(private readonly execute: (effect: RoomEffect) => void) {}

  publish(effects: RoomEffect[]): void {
    if (this.pending) this.pending.push(...effects);
    else for (const effect of effects) this.execute(effect);
  }

  run<T>(action: () => T): T {
    const parent = this.pending;
    const pending: RoomEffect[] = [];
    this.pending = pending;
    let result: T;
    try {
      result = action();
    } finally {
      this.pending = parent;
    }
    this.publish(pending);
    return result;
  }
}
