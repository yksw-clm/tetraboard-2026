import { roomSocketContract } from "@tetraboard/protocol";
import { reportClientError } from "./clientErrors";
import { preloadRecovery } from "./preloadRecovery";

export const roomReloadMessage =
  "アプリが更新されました。最新の画面を表示するには、再読み込みしてください。";

export type RoomResponseType =
  | "room.get"
  | "room.membership"
  | "room.viewer"
  | "room.shogi-replay"
  | "room.four-shogi-replay"
  | "player.profile"
  | "rating.result";

export class RoomResponseValidationError extends Error {
  readonly responseType: RoomResponseType;
  constructor(responseType: RoomResponseType) {
    super("Room response validation failed");
    this.responseType = responseType;
  }
}

const listeners = new Set<
  (roomId: string | undefined, error: RoomResponseValidationError) => void
>();

export function subscribeRoomResponseValidation(
  listener: (roomId: string | undefined, error: RoomResponseValidationError) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyRoomResponseValidation(
  responseType: RoomResponseType,
  roomId?: string,
  signal?: AbortSignal,
): RoomResponseValidationError {
  signal?.throwIfAborted();
  const error = new RoomResponseValidationError(responseType);
  for (const listener of listeners) listener(roomId, error);
  return error;
}

export function parseRoomResponse<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
  responseType: RoomResponseType,
  roomId: string,
  signal?: AbortSignal,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw notifyRoomResponseValidation(responseType, roomId, signal);
}

export function roomSocketResponseType(value: unknown): string {
  const type = value && typeof value === "object" && "type" in value ? value.type : undefined;
  // 未検証の任意文字列を計測に流さず、契約で既知の種類だけを記録します。
  return (
    roomSocketContract.message.options.find((schema) => schema.shape.type.value === type)?.shape
      .type.value ?? "room.unknown"
  );
}

export function requestRoomReload(responseType: string): void {
  reportClientError("RoomResponseValidationError", responseType);
  preloadRecovery.tryAutoReload();
}
