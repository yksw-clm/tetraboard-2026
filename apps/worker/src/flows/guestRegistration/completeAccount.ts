import type { RegistrationIdentity } from "@tetraboard/context-account";
import type { StoredProfile } from "../../accounts/auth";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { reserveAccountSeat, cancelReservation } from "../accountSeats/reserve";
import { RoomAccountError } from "../accountSeats/entryProfile";
import { acceptMatchClaim, readMatchClaimState } from "../../adapters/record/matchClaims";
import { browserIdFromRequest } from "../../usageEvents/browserId";
import { D1RegistrationWrites } from "../../adapters/account/registrationWrites";
import {
  RegistrationError,
  readRegistrationFlow,
  registrationStatus,
  assertRegistrationAccount,
  requireRegistrationConsent,
  type RegistrationFlow,
} from "./account";
import { completeLinkedGuestSeat } from "./linkedSeat";
export async function completeAccountRegistration(
  request: Request,
  env: Env,
  flow: RegistrationFlow,
) {
  const identity = await assertRegistrationAccount(request, env, flow, true);
  await requireRegistrationConsent(env.APP_DB, identity.user.id);
  if (flow.guest_account_id) {
    await completeLinkedGuestSeat(env, flow, identity.user);
    return registrationStatus(request, env, flow);
  }
  await acceptRegistrationRecord(env, flow, identity);
  await completeAccountSeat(request, env, flow, identity.user);
  return registrationStatus(request, env, (await readRegistrationFlow(env.APP_DB, flow.id))!);
}
async function acceptRegistrationRecord(
  env: Env,
  flow: RegistrationFlow,
  identity: RegistrationIdentity,
) {
  const store = new D1RegistrationWrites(env.APP_DB);
  if (!flow.player_id)
    throw new RegistrationError("preparing", 503, "登録の準備を再試行してください。");
  const priorClaim = await readMatchClaimState(
    env.APP_DB,
    flow.match_id,
    flow.player_id,
    identity.user.id,
  );
  if (!priorClaim && !flow.record_accepted_at_ms && flow.claim_until_ms <= Date.now())
    throw new RegistrationError("expired", 410, "対局を引き継ぐ受付期限が過ぎました。");
  const room = env.GAME_ROOM.getByName(flow.room_id);
  if (!priorClaim) {
    const eligibility = await room.validateGuestRegistrationAccount(flow.id, identity.user.id);
    if (eligibility !== "eligible")
      throw new RegistrationError(
        eligibility,
        eligibility === "expired" ? 410 : eligibility === "not_found" ? 503 : 409,
        eligibility === "conflict"
          ? "このアカウントは同じ対局の別の席に参加しています。"
          : "登録手続きの状態が変わりました。結果画面から確認してください。",
      );
  }
  await acceptMatchClaim(
    env.APP_DB,
    {
      matchId: flow.match_id,
      playerId: flow.player_id,
      accountId: identity.user.id,
      roomId: flow.room_id,
      instanceId: flow.instance_id,
    },
    { registrationId: flow.id, sessionId: identity.sessionId },
  );
  await store.acceptRecord(flow.id, Date.now());
  await room.armGuestMatchClaims();
}
async function completeAccountSeat(
  request: Request,
  env: Env,
  flow: RegistrationFlow,
  user: StoredProfile,
) {
  const store = new D1RegistrationWrites(env.APP_DB);
  const room = env.GAME_ROOM.getByName(flow.room_id);
  const state = await room.getGuestRegistration(flow.id);
  if (state?.state === "pending" && state.holdUntilMs > Date.now()) {
    let admission;
    try {
      const headers = new Headers(request.headers);
      // 同意はDBで検証済みです。古い予約の回収後も同じ条件でプロフィールを再読込します。
      headers.set("X-Legal-Consent", legalVersion);
      admission = await reserveAccountSeat(
        new Request(request, { headers }),
        env,
        user,
        { id: flow.room_id, instanceId: flow.instance_id },
        flow.player_id!,
        { reuseForGuestRegistration: true },
      );
      const result = await room.completeGuestRegistration(flow.id, admission, {
        visitorId: browserIdFromRequest(request),
        accountId: user.id,
        isTest: Boolean(user.isTestUser),
      });
      if (result.status === "converted") {
        await store.completeSeat(flow.id);
      } else {
        await cancelReservation(env, admission);
        await store.seat(
          flow.id,
          result.status === "expired"
            ? "expired"
            : result.status === "cancelled"
              ? "cancelled"
              : "unavailable",
        );
      }
    } catch (error) {
      if (error instanceof RoomAccountError && error.code === "account_seated") {
        await store.conflictSeat(flow.id);
      } else {
        // 結果不明の予約はDOを照合して回復します。確定済み席を解放しません。
        if (admission) await cancelReservation(env, admission).catch(() => undefined);
        throw error;
      }
    }
  }
}
