import { queueDocumentController as controller } from "../../shared/QueueDocumentController";
import { clearRoomMembershipToken, saveRoomMembershipToken } from "../../shared/roomMembership";
import { readAccount } from "../account/accountApi";
import {
  readMatchmakingRoom,
  saveMatchmakingQueue,
  saveMatchmakingRoom,
} from "./matchmakingStorage";
import { readMatchmaking, matchmakingOperation } from "./matchmakingApi";
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
  const scope = `matchmaking:${stored.identity}`,
    id = controller.getIdentity();
  let state = await readMatchmaking(id, signal);
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
      "takeover",
      { operationId: stored.operationId, controllerId: id, version: state.version! },
      signal,
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
  saveMatchmakingQueue(stored.identity, credential);
  if (
    !saveRoomMembershipToken(roomId, state.assignment.membership.token) ||
    !saveMatchmakingRoom({ ...credential, identity: stored.identity, roomId, instanceId })
  )
    throw Error("参加資格を保存できません。");
}
