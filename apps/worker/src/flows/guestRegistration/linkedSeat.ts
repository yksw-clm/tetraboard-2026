import { accountAvatarPresetId } from "@tetraboard/protocol";
import { avatarKeyPattern, type StoredProfile } from "../../adapters/account/auth";
import { updateLinkedSeat } from "../../adapters/account/registrationSeats";
import { D1RegistrationWrites } from "../../adapters/account/registrationWrites";
import { guestRoomLinkComplete, RegistrationError, type RegistrationFlow } from "./account";
export async function completeLinkedGuestSeat(
  env: Env,
  flow: RegistrationFlow,
  user: StoredProfile,
) {
  if (!(await guestRoomLinkComplete(env.APP_DB, flow)))
    throw new RegistrationError("conflict", 409, "先にゲスト記録の引き継ぎを確認してください。");
  const room = env.GAME_ROOM.getByName(flow.room_id);
  const held = await room.getGuestRegistration(flow.id);
  if (held?.state !== "pending" || !flow.player_id) return;
  const db = env.APP_DB;
  const avatarKey = user.avatarKey && avatarKeyPattern.test(user.avatarKey) ? user.avatarKey : null;
  const avatarPresetId = accountAvatarPresetId(user.id, user.avatarPresetId);
  const updated = await updateLinkedSeat(db, flow, user, avatarKey, avatarPresetId);
  const operationId = updated[0].results[0]?.operation_id;
  if (!operationId) {
    if ((await room.getGuestRegistration(flow.id))?.state !== "pending") return;
    throw new RegistrationError("conflict", 409, "現在の席を確認できません。再試行してください。");
  }
  const result = await room.completeGuestRegistration(
    flow.id,
    {
      accountId: user.id,
      operationId,
      roomId: flow.room_id,
      instanceId: flow.instance_id,
      playerId: flow.player_id,
      name: user.name,
      avatarKey,
      avatarPresetId,
    },
    { visitorId: null, accountId: user.id, isTest: Boolean(user.isTestUser) },
  );
  if (result.status === "converted") await new D1RegistrationWrites(db).completeSeat(flow.id);
  else if ((await room.getGuestRegistration(flow.id))?.state === "pending")
    throw new RegistrationError(
      "conflict",
      409,
      "席を切り替えられませんでした。再試行してください。",
    );
}
