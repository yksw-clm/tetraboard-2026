import { queueDocumentController as controller } from "../../shared/QueueDocumentController";
import { clearRoomMembershipToken, saveRoomMembershipToken } from "../../shared/roomMembership";
import { readAccount } from "../account/accountApi";
import {
  readMatchmakingRoom,
  saveMatchmakingQueue,
  saveMatchmakingRoom,
} from "./matchmakingStorage";
import { readMatchmaking, matchmakingOperation } from "./matchmakingApi";
import { matchmakingScope } from "./paths";
export async function recoverMatchmakingRoom(
  roomId: string,
  instanceId: string,
  signal: AbortSignal,
) {
  const stored = readMatchmakingRoom(roomId, instanceId);
  if (!stored) return;
  const user = await readAccount(signal);
  if (!user || user.profileId !== stored.identity) {
    clearRoomMembershipToken(roomId);
    return;
  }
  const game = stored.game ?? "four-reversi";
  const legacy = stored.game === undefined;
  const scope = matchmakingScope(stored.identity, game, legacy),
    id = controller.getIdentity();
  let state = await readMatchmaking(game, id, signal, legacy);
  if (state.operationId !== stored.operationId) {
    clearRoomMembershipToken(roomId);
    return;
  }
  if (state.controllerId !== id) {
    if (!controller.isReload() || !(await controller.acquire(scope))) {
      clearRoomMembershipToken(roomId);
      return;
    }
    state = await matchmakingOperation(
      game,
      "takeover",
      { operationId: stored.operationId, controllerId: id, version: state.version! },
      signal,
      legacy,
    );
  }
  if (
    state.controllerId !== id ||
    !state.assignment ||
    state.assignment.roomId !== roomId ||
    state.assignment.instanceId !== instanceId
  ) {
    clearRoomMembershipToken(roomId);
    return;
  }
  controller.remember(scope, stored.operationId, state.version!);
  controller.announce(scope);
  const credential = { operationId: stored.operationId, controllerId: id, version: state.version! };
  if (!legacy) saveMatchmakingQueue(stored.identity, credential, game);
  if (
    !saveRoomMembershipToken(roomId, state.assignment.membership.token) ||
    !saveMatchmakingRoom({ ...stored, ...credential })
  )
    throw Error("参加資格を保存できません。");
}
