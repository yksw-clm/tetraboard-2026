import type { GameId, Room } from "@tetraboard/protocol";
import { createUuid } from "./createUuid";

// 履歴に残った nonce だけでは、再読み込み後に作成を再実行できません。
const pending = new Map<string, Room["settings"]>();

export function createFriendRoomIntent(settings: Room["settings"]) {
  const friendRoomNonce = createUuid();
  pending.set(friendRoomNonce, settings);
  return { friendRoomNonce };
}

export function takeFriendRoomSettings(nonce: string, game: GameId): Room["settings"] | undefined {
  const settings = pending.get(nonce);
  if (settings?.game !== game) return undefined;
  pending.delete(nonce);
  return settings;
}
