import {
  matchmakingQueueReferenceSchema as schema,
  matchmakingRoomReferenceSchema as roomSchema,
} from "@tetraboard/protocol";

const key = (identity: string) => `tetraboard:matchmaking:${identity}`;
export function readMatchmakingQueue(identity: string) {
  try {
    const parsed = schema.safeParse(JSON.parse(sessionStorage.getItem(key(identity)) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function saveMatchmakingQueue(identity: string, value: ReturnType<typeof schema.parse>) {
  try {
    sessionStorage.setItem(key(identity), JSON.stringify(schema.parse(value)));
    if (readMatchmakingQueue(identity)?.operationId !== value.operationId) throw Error();
  } catch {
    throw Error("待機情報を保存できません。ブラウザの保存領域を確認してください。");
  }
}
export function clearMatchmakingQueue(identity: string) {
  try {
    sessionStorage.removeItem(key(identity));
  } catch {
    /* 有効期限でも回収します。 */
  }
}

export function saveMatchmakingRoom(value: ReturnType<typeof roomSchema.parse>) {
  try {
    sessionStorage.setItem(
      `tetraboard:matchmaking-room:${value.roomId}`,
      JSON.stringify(roomSchema.parse(value)),
    );
    return true;
  } catch {
    return false;
  }
}
export function readMatchmakingRoom(roomId: string, instanceId?: string) {
  try {
    const parsed = roomSchema.safeParse(
      JSON.parse(sessionStorage.getItem(`tetraboard:matchmaking-room:${roomId}`) ?? "null"),
    );
    return parsed.success && (!instanceId || parsed.data.instanceId === instanceId)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
