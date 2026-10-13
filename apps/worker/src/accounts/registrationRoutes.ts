import { Hono } from "hono";
import { z } from "zod";
import {
  startRegistrationSchema,
  registrationStatusSchema,
  membershipTokenSchema,
} from "@tetraboard/protocol";
import { accountSessionIdentity } from "./auth";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { analyticsVisitor } from "../analytics/store";
import { digest } from "../privacy/deletion";
import { reserveAccountSeat, cancelReservation, RoomAccountError } from "./roomAccounts";
import { acceptMatchClaim, readMatchClaimState, MatchClaimError } from "./matchClaims";
import {
  RegistrationError,
  readRegistrationFlow,
  registrationFromRequest,
  registrationStatus,
  assertRegistrationAccount,
  requireRegistrationConsent,
} from "./registrationFlows";

export const registrationRoutes = new Hono<{ Bindings: Env }>();
registrationRoutes.use("*", async (c, next) => {
  if (
    !/\/(registrations\/[^/]+(?:\/(?:complete|cancel))?|rooms\/[^/]+\/registration)$/.test(
      new URL(c.req.url).pathname,
    )
  ) {
    await next();
    return;
  }
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET" && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ error: "unauthorized", message: "操作元を確認できません。" }, 403);
  await next();
});
registrationRoutes.onError((error, c) => {
  if (error instanceof RegistrationError)
    return c.json({ error: error.code, message: error.message }, error.status);
  if (error instanceof MatchClaimError)
    return c.json({ error: error.code, message: "この対局は引き継げません。" }, 409);
  console.error("Registration handoff failed");
  return c.json(
    {
      error: "internal_error",
      message: "登録の引き継ぎを完了できませんでした。もう一度お試しください。",
    },
    503,
  );
});

registrationRoutes.post("/rooms/:roomId/registration", async (c) => {
  const input = startRegistrationSchema.safeParse(await c.req.json().catch(() => null));
  const roomId = c.req.param("roomId");
  const authorization = c.req.header("Authorization");
  const token = membershipTokenSchema.safeParse(
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
  );
  if (!input.success || !/^\d{5}$/.test(roomId))
    throw new RegistrationError("invalid_request", 400, "登録情報が正しくありません。");
  if (!token.success)
    throw new RegistrationError("unauthorized", 401, "参加資格を確認できません。");
  const data = input.data;
  const secretHash = await digest(data.secret);
  const oldTokenHash = await digest(token.data);
  if (oldTokenHash === data.newTokenHash)
    throw new RegistrationError("invalid_request", 400, "新しい参加資格を用意してください。");
  const now = Date.now();
  await c.env.APP_DB.prepare(`INSERT INTO registration_flows
    (id,secret_hash,room_id,instance_id,match_id,old_token_hash,new_token_hash,created_at_ms,hold_until_ms,claim_until_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(
      data.registrationId,
      secretHash,
      roomId,
      data.instanceId,
      data.matchId,
      oldTokenHash,
      data.newTokenHash,
      now,
      now + 600_000,
      now + 3_600_000,
    )
    .run();
  const flow = (await readRegistrationFlow(c.env.APP_DB, data.registrationId))!;
  if (
    flow.secret_hash !== secretHash ||
    flow.room_id !== roomId ||
    flow.instance_id !== data.instanceId ||
    flow.match_id !== data.matchId ||
    flow.old_token_hash !== oldTokenHash ||
    flow.new_token_hash !== data.newTokenHash
  )
    throw new RegistrationError("conflict", 409, "登録手続きの内容が一致しません。");
  if (flow.cancelled_at_ms !== null)
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  const result = await c.env.GAME_ROOM.getByName(roomId).beginGuestRegistration({
    registrationId: flow.id,
    instanceId: flow.instance_id,
    matchId: flow.match_id,
    oldTokenHash,
    newTokenHash: flow.new_token_hash,
  });
  if (result.status !== "started") {
    // 認証を拒否した開始要求は残しません。RPCの結果不明時は同じIDで再試行できます。
    await c.env.APP_DB.prepare(
      "DELETE FROM registration_flows WHERE id=? AND secret_hash=? AND player_id IS NULL AND cancelled_at_ms IS NULL",
    )
      .bind(flow.id, secretHash)
      .run();
    throw new RegistrationError(
      result.status,
      result.status === "unauthorized"
        ? 401
        : result.status === "not_found"
          ? 404
          : result.status === "expired"
            ? 410
            : 409,
      "この結果から登録を始められません。ルームの状態を確認してください。",
    );
  }
  const registered = result.registration;
  await c.env.APP_DB.prepare(
    `UPDATE registration_flows SET player_id=?,created_at_ms=?,hold_until_ms=?,claim_until_ms=? WHERE id=? AND cancelled_at_ms IS NULL`,
  )
    .bind(
      registered.playerId,
      registered.startedAtMs,
      registered.holdUntilMs,
      registered.claimUntilMs,
      flow.id,
    )
    .run();
  const current = (await readRegistrationFlow(c.env.APP_DB, flow.id))!;
  if (current.cancelled_at_ms !== null) {
    await c.env.GAME_ROOM.getByName(roomId).cancelGuestRegistration(flow.id);
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  }
  return c.json(
    registrationStatusSchema.parse(await registrationStatus(c.req.raw, c.env, current)),
  );
});

registrationRoutes.get("/registrations/:registrationId", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  return c.json(registrationStatusSchema.parse(await registrationStatus(c.req.raw, c.env, flow)));
});

registrationRoutes.post("/registrations/:registrationId/complete", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  const identity = await assertRegistrationAccount(c.req.raw, c.env, flow, true);
  await requireRegistrationConsent(c.env.APP_DB, identity.user.id);
  if (!flow.player_id)
    throw new RegistrationError("preparing", 503, "登録の準備を再試行してください。");
  const priorClaim = await readMatchClaimState(
    c.env.APP_DB,
    flow.match_id,
    flow.player_id,
    identity.user.id,
  );
  if (!priorClaim && !flow.record_accepted_at_ms && flow.claim_until_ms <= Date.now())
    throw new RegistrationError("expired", 410, "対局を引き継ぐ受付期限が過ぎました。");
  const room = c.env.GAME_ROOM.getByName(flow.room_id);
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
    c.env.APP_DB,
    {
      matchId: flow.match_id,
      playerId: flow.player_id,
      accountId: identity.user.id,
      roomId: flow.room_id,
      instanceId: flow.instance_id,
    },
    { registrationId: flow.id, sessionId: identity.sessionId },
  );
  await c.env.APP_DB.prepare(
    "UPDATE registration_flows SET record_accepted_at_ms=COALESCE(record_accepted_at_ms,?) WHERE id=?",
  )
    .bind(Date.now(), flow.id)
    .run();
  await room.armGuestMatchClaims();
  const state = await room.getGuestRegistration(flow.id);
  if (state?.state === "pending" && state.holdUntilMs > Date.now()) {
    let admission;
    try {
      const headers = new Headers(c.req.raw.headers);
      // 同意はDBで検証済みです。古い予約の回収後も同じ条件でプロフィールを再読込します。
      headers.set("X-Legal-Consent", legalVersion);
      admission = await reserveAccountSeat(
        new Request(c.req.raw, { headers }),
        c.env,
        identity.user,
        { id: flow.room_id, instanceId: flow.instance_id },
        flow.player_id,
        { reuseForGuestRegistration: true },
      );
      const result = await room.completeGuestRegistration(flow.id, admission, {
        visitorId: analyticsVisitor(c.req.raw),
        accountId: identity.user.id,
        isTest: Boolean(identity.user.isTestUser),
      });
      if (result.status === "converted") {
        await c.env.APP_DB.prepare("UPDATE registration_flows SET seat_state='complete' WHERE id=?")
          .bind(flow.id)
          .run();
      } else {
        await cancelReservation(c.env, admission);
        await c.env.APP_DB.prepare("UPDATE registration_flows SET seat_state=? WHERE id=?")
          .bind(
            result.status === "expired"
              ? "expired"
              : result.status === "cancelled"
                ? "cancelled"
                : "unavailable",
            flow.id,
          )
          .run();
      }
    } catch (error) {
      if (error instanceof RoomAccountError && error.code === "account_seated") {
        await c.env.APP_DB.prepare("UPDATE registration_flows SET seat_state='conflict' WHERE id=?")
          .bind(flow.id)
          .run();
      } else {
        // 結果不明の予約はDOを照合して回復します。確定済み席を解放しません。
        if (admission) await cancelReservation(c.env, admission).catch(() => undefined);
        throw error;
      }
    }
  }
  return c.json(
    registrationStatusSchema.parse(
      await registrationStatus(
        c.req.raw,
        c.env,
        (await readRegistrationFlow(c.env.APP_DB, flow.id))!,
      ),
    ),
  );
});

registrationRoutes.post("/registrations/:registrationId/cancel", async (c) => {
  const flow = await registrationFromRequest(c.req.raw, c.env, c.req.param("registrationId"));
  const body = z
    .object({ signOut: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success)
    throw new RegistrationError("invalid_request", 400, "中止の指定が正しくありません。");
  const room = c.env.GAME_ROOM.getByName(flow.room_id);
  const state = await room.cancelGuestRegistration(flow.id);
  if (state?.state === "converted")
    throw new RegistrationError(
      "already_complete",
      409,
      "この席は登録ユーザーへ切り替わっています。",
    );
  const identity = body.data.signOut ? await accountSessionIdentity(c.req.raw, c.env) : null;
  const cancelled = await c.env.APP_DB.batch<{
    account_id: string | null;
    session_id: string | null;
  }>([
    c.env.APP_DB.prepare(
      "UPDATE registration_flows SET cancelled_at_ms=COALESCE(cancelled_at_ms,?),seat_state='cancelled' WHERE id=? RETURNING account_id,session_id",
    ).bind(Date.now(), flow.id),
    c.env.APP_DB.prepare("DELETE FROM registration_oauth_states WHERE registration_id=?").bind(
      flow.id,
    ),
    ...(body.data.signOut
      ? [
          c.env.APP_DB.prepare(`DELETE FROM session WHERE EXISTS (SELECT 1 FROM registration_flows f
            WHERE f.id=? AND f.session_id=session.id AND f.account_id=session.userId)`).bind(
            flow.id,
          ),
        ]
      : []),
  ]);
  const fixed = cancelled[0].results[0];
  if (
    body.data.signOut &&
    identity &&
    fixed &&
    identity.sessionId === fixed.session_id &&
    identity.user.id === fixed.account_id
  ) {
    const secure = new URL(c.env.APP_ORIGIN).protocol === "https:";
    c.header(
      "Set-Cookie",
      `${secure ? "__Secure-" : ""}tetraboard-2026.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
      { append: true },
    );
  }
  // 開始RPCが未確定でも取消は確定できます。本人位置はまだ返せません。
  if (!flow.player_id) return c.body(null, 204);
  return c.json(
    registrationStatusSchema.parse(
      await registrationStatus(
        c.req.raw,
        c.env,
        (await readRegistrationFlow(c.env.APP_DB, flow.id))!,
      ),
    ),
  );
});
