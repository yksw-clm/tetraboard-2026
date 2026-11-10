import {
  matchmakingQueueReferenceSchema as schema,
  matchmakingRoomReferenceSchema as roomSchema,
} from "@tetraboard/protocol";
import type { MatchmakingGame } from "@tetraboard/protocol";
import { matchmakingScope } from "./paths";

const key = (identity: string, game: MatchmakingGame, legacy = false) =>
  `tetraboard:${matchmakingScope(identity, game, legacy)}`;
export function readMatchmakingQueue(
  identity: string,
  game: MatchmakingGame = "four-reversi",
  legacy = false,
) {
  try {
    const parsed = schema.safeParse(
      JSON.parse(sessionStorage.getItem(key(identity, game, legacy)) ?? "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function saveMatchmakingQueue(
  identity: string,
  value: ReturnType<typeof schema.parse>,
  game: MatchmakingGame = "four-reversi",
) {
  try {
    sessionStorage.setItem(key(identity, game), JSON.stringify(schema.parse(value)));
    if (readMatchmakingQueue(identity, game)?.operationId !== value.operationId) throw Error();
  } catch {
    throw Error("待機情報を保存できません。ブラウザの保存領域を確認してください。");
  }
}
export function clearMatchmakingQueue(
  identity: string,
  game: MatchmakingGame = "four-reversi",
  legacy = false,
) {
  try {
    sessionStorage.removeItem(key(identity, game, legacy));
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
