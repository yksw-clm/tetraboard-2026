/// <reference types="node" />
import type { Room } from "@tetraboard/protocol";
import { AsyncLocalStorage } from "node:async_hooks";

type AlarmStorage = {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

const schedules = new WeakMap<object, RoomAlarmEvents>();

export class RoomAlarmEvents {
  private dirty = false;
  private synchronousRoom: Room | null | undefined;
  private syncing: Promise<void> | null = null;
  private activeWork = 0;
  // 外部応答待ちに届いた別イベントを、入れ子の呼び出しと区別します。
  private readonly event = new AsyncLocalStorage<{ active: boolean }>();

  constructor(
    owner: object,
    private readonly storage: AlarmStorage,
    private readonly nextAlarmAt: (room?: Room | null) => number | null,
    private readonly waitUntil: (task: Promise<void>) => void,
  ) {
    schedules.set(owner, this);
  }

  // 同期的に始まる Alarm 計算だけに渡し、await を越えて保持しません。
  withRoom(room: Room | null, action: () => void): void {
    const parent = this.synchronousRoom;
    this.synchronousRoom = room;
    try {
      action();
    } finally {
      this.synchronousRoom = parent;
    }
  }

  mark(): void {
    this.dirty = true;
    if (!this.event.getStore()?.active) this.waitUntil(this.sync());
  }

  async sync(): Promise<void> {
    while (this.syncing) await this.syncing;
    if (!this.dirty) return;
    this.dirty = false;
    this.syncing = this.syncAlarm().catch((error) => {
      this.dirty = true;
      throw error;
    });
    try {
      await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  async afterFlush(): Promise<void> {
    this.mark();
    await this.sync();
  }

  private async syncAlarm(): Promise<void> {
    const next = this.nextAlarmAt(this.synchronousRoom);
    const current = await this.storage.getAlarm();
    if (next === current) return;
    if (next === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(next);
  }

  get hasActiveWork(): boolean {
    return this.activeWork > 0 || this.syncing !== null;
  }

  async trackWork<T>(action: () => Promise<T>): Promise<T> {
    this.activeWork++;
    try {
      return await action();
    } finally {
      this.activeWork--;
    }
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.event.getStore()?.active) return action();
    const event = { active: true };
    return this.trackWork(() =>
      this.event.run(event, async () => {
        try {
          return await action();
        } finally {
          event.active = false;
          await this.sync();
        }
      }),
    );
  }
}

// RPCで呼べるprototypeメソッドのまま、全入口に同じラッパーを適用します。
export const eventMethods = [
  "guestMergeConflict",
  "purgeAccount",
  "getGuestRegistration",
  "validateGuestRegistrationAccount",
  "armGuestMatchClaims",
  "beginGuestRegistration",
  "cancelGuestRegistration",
  "completeGuestRegistration",
  "accountReservationState",
  "cancelAccountReservation",
  "getFourShogiAnalysisReplay",
  "getShogiReplay",
  "prepareTournamentRoom",
  "getTournamentReservationState",
  "abortTournamentRoom",
  "rekeyTournamentPlayer",
  "prepareMatchmakingRoom",
  "getMatchmakingState",
  "abortMatchmakingRoom",
  "rekeyMatchmakingPlayer",
  "createRoom",
  "getRoom",
  "getShareMetadata",
  "getRoomSnapshot",
  "getRoomEntrySnapshot",
  "resolvePlayerProfile",
  "refreshLobbyIndex",
  "getPublicMetadata",
  "getRoomMembership",
  "joinRoom",
  "alarm",
  "leaveRoom",
  "issueViewerToken",
  "inspectReport",
  "moderateMessage",
  "fetch",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
] as const;

export function wrapRoomAlarmEvents<
  T extends Record<(typeof eventMethods)[number], (...args: never[]) => Promise<unknown>>,
>(type: { prototype: T }): void {
  for (const name of eventMethods) {
    const method = type.prototype[name];
    Object.defineProperty(type.prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: T, ...args: unknown[]): Promise<unknown> {
        const schedule = schedules.get(this);
        if (!schedule) throw new Error("Room alarm events are not initialized");
        return schedule.run(() => Reflect.apply(method, this, args));
      },
    });
  }
}
