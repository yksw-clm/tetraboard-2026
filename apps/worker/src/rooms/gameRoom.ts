import { roomSchema, type Room } from "@tetraboard/protocol";
import { DurableObject } from "cloudflare:workers";

const roomStorageKey = "room";

export class GameRoom extends DurableObject<Env> {
  createRoom(room: Room): Room | null {
    const initialRoom = roomSchema.parse(room);

    if (initialRoom.id !== this.ctx.id.name) {
      throw new Error("Room code does not match Durable Object name");
    }

    return this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.kv.get(roomStorageKey) !== undefined) {
        return null;
      }

      this.ctx.storage.kv.put(roomStorageKey, initialRoom);
      return initialRoom;
    });
  }

  getRoom(): Room | null {
    const room = this.ctx.storage.kv.get(roomStorageKey);
    return room === undefined ? null : roomSchema.parse(room);
  }
}
