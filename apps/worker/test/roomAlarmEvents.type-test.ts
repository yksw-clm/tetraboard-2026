import type { GameRoom } from "../src/rooms/gameRoom";
import type { eventMethods } from "../src/rooms/roomAlarmEvents";
import type { RoomAlarmEvents } from "../src/rooms/roomAlarmEvents";

type PublicMethods<T> = {
  [K in keyof T]-?: Extract<T[K], (...args: never[]) => unknown> extends never ? never : K;
}[keyof T];

const nonEventMethods = {
  connect: "Cloudflareの基底クラスの任意ハンドラーで、GameRoomは実装していません。",
} satisfies Partial<Record<PublicMethods<GameRoom>, string>>;
type UnimplementedEvents<T> = {
  [K in keyof typeof nonEventMethods & keyof T]-?: undefined extends T[K] ? K : never;
}[keyof typeof nonEventMethods & keyof T];
type MissingEvents<T> = Exclude<
  PublicMethods<T>,
  (typeof eventMethods)[number] | UnimplementedEvents<T>
>;
type CompleteEvents<T> = [MissingEvents<T>] extends [never] ? true : never;

export const completeRoomEvents: CompleteEvents<GameRoom> = true;

// @ts-expect-error publicメソッドを追加して入口一覧へ登録し忘れると失敗します。
export const missingRoomEvent: CompleteEvents<GameRoom & { addedEvent(): Promise<void> }> = true;

// @ts-expect-error 同期のpublicメソッドも入口一覧への登録が必要です。
export const missingSyncRoomEvent: CompleteEvents<GameRoom & { addedSyncEvent(): void }> = true;

// @ts-expect-error 任意ハンドラーを実装したら、除外したままにはできません。
export const missingConnectEvent: CompleteEvents<GameRoom & { connect(): void }> = true;

export const nonMethodsNeedNoEntry: CompleteEvents<GameRoom & { data: string; brand: never }> =
  true;

declare const events: RoomAlarmEvents;
// @ts-expect-error 印にルームを渡して保持させることはできません。
events.mark(null);
