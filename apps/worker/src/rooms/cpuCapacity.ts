import { DurableObject } from "cloudflare:workers";

const limits = {
  reversi: { matches: 4, seats: 4, seatsPerMatch: 1 },
  shogi: { matches: 4, seats: 4, seatsPerMatch: 1 },
  "four-reversi": { matches: 4, seats: 12, seatsPerMatch: 3 },
  "four-shogi": { matches: 4, seats: 12, seatsPerMatch: 3 },
};

export type CpuCapacityGame = keyof typeof limits;

type Reservation = { sequence: number; seats: number };
const activeKey = (roomId: string) => `active:${roomId}`;
const releasedKey = (roomId: string) => `released:${roomId}`;

export class CpuCapacity extends DurableObject<Env> {
  private get limit() {
    const game = this.ctx.id.name;
    if (!game || !Object.hasOwn(limits, game)) throw new Error("Unknown CPU capacity");
    return limits[game as CpuCapacityGame];
  }

  availableSeats(): number {
    const limit = this.limit;
    const reservations = [...this.ctx.storage.kv.list<Reservation>({ prefix: "active:" })];
    const usedSeats = reservations.reduce((sum, [, reservation]) => sum + reservation.seats, 0);
    return Math.max(
      0,
      Math.min(
        limit.seats - usedSeats,
        (limit.matches - reservations.length) * limit.seatsPerMatch,
      ),
    );
  }

  reserve(roomId: string, sequence: number, seats: number): boolean {
    const limit = this.limit;
    if (!Number.isInteger(seats) || seats < 1 || seats > limit.seatsPerMatch)
      throw new Error("Invalid CPU seat count");
    return this.ctx.storage.transactionSync(() => {
      const released = this.ctx.storage.kv.get<number>(releasedKey(roomId)) ?? 0;
      if (sequence <= released) return false;
      const existing = this.ctx.storage.kv.get<Reservation>(activeKey(roomId));
      if (existing) return existing.sequence === sequence && existing.seats === seats;
      const reservations = [...this.ctx.storage.kv.list<Reservation>({ prefix: "active:" })];
      let usedSeats = 0;
      for (const [, active] of reservations) usedSeats += active.seats;
      if (reservations.length >= limit.matches || usedSeats + seats > limit.seats) return false;
      this.ctx.storage.kv.put(activeKey(roomId), { sequence, seats } satisfies Reservation);
      return true;
    });
  }

  release(roomId: string, sequence: number): void {
    this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.kv.get<number>(releasedKey(roomId)) ?? 0;
      // 解放の後から届いた取得要求も無効にします。部屋ごとに最新の番号を残します。
      if (sequence > previous) this.ctx.storage.kv.put(releasedKey(roomId), sequence);
      const active = this.ctx.storage.kv.get<Reservation>(activeKey(roomId));
      if (active?.sequence === sequence) this.ctx.storage.kv.delete(activeKey(roomId));
    });
  }
}
