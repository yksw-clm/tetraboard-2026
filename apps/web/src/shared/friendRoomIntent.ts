import type { GameId, Room } from "@tetraboard/protocol";
import { createUuid } from "./createUuid";

export type FriendRoomConsent = {
  profileId: string | null;
  legalVersion: string;
};

export type FriendRoomIntent = FriendRoomConsent & { settings: Room["settings"] };

// 履歴に残った nonce だけでは、再読み込み後に作成を再実行できません。
const pending = new Map<string, FriendRoomIntent>();

export function createFriendRoomIntent(settings: Room["settings"], consent: FriendRoomConsent) {
  const friendRoomNonce = createUuid();
  pending.set(friendRoomNonce, { ...consent, settings });
  return { friendRoomNonce };
}

export function takeFriendRoomIntent(nonce: string, game: GameId): FriendRoomIntent | undefined {
  const intent = pending.get(nonce);
  if (intent?.settings.game !== game) return undefined;
  pending.delete(nonce);
  return intent;
}
