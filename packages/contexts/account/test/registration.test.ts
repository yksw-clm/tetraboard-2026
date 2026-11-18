import { expect, test } from "bun:test";
import {
  assertRegistrationAccount,
  assertRegistrationSetup,
  assertRegistrationOAuth,
  startRegistration,
  recordRegistrationStart,
  cancelGuestRegistration,
  getRegistrationStatus,
  registrationStatus,
  registrationWithSecret,
  prepareRegistrationOAuth,
  rememberRegistrationOAuth,
  completeRegistrationOAuth,
  requireRegistrationConsent,
  type RegistrationFlow,
  type RegistrationObservations,
} from "../src";
import { user } from "./fixtures";
import { flow, start, MemoryRegistrations } from "./registrationFixtures";
const identity = { user, sessionId: "session" };
const bound = { ...flow, account_id: user.id, session_id: "session" };
test("同じ開始要求は期限を延ばさず、異なる対象・資格・取消済みの再開を拒否します", async () => {
  const memory = new MemoryRegistrations();
  expect(await startRegistration(memory, { ...start, now: 5000 })).toEqual(flow);
  expect(memory.events).toEqual(["create", "read:registration"]);
  for (const patch of [
    { secret_hash: "other" },
    { room_id: "other" },
    { instance_id: "other" },
    { match_id: "other" },
    { old_token_hash: "other" },
    { new_token_hash: "other" },
    { guest_account_id: "other" },
  ]) {
    memory.flow = { ...flow, ...patch };
    await expect(startRegistration(memory, start)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
  }
  memory.flow = { ...flow, cancelled_at_ms: 5000 };
  await expect(startRegistration(memory, start)).rejects.toMatchObject({ code: "cancelled" });
  memory.events = [];
  await expect(startRegistration(memory, { ...start, newTokenHash: "old" })).rejects.toMatchObject({
    code: "invalid_request",
  });
  expect(memory.events).toEqual([]);
});
test("開始RPC後の確定値を読み直し、先に確定した取消を上書きしません", async () => {
  const memory = new MemoryRegistrations();
  const state = {
    playerId: "player",
    startedAtMs: 2000,
    holdUntilMs: 602000,
    claimUntilMs: 3602000,
  };
  expect(await recordRegistrationStart(memory, flow.id, state)).toMatchObject({
    created_at_ms: 2000,
    hold_until_ms: 602000,
  });
  expect(memory.events).toEqual(["started", "read:registration"]);
  memory.flow = { ...flow, cancelled_at_ms: 1500 };
  expect(await recordRegistrationStart(memory, flow.id, state)).toEqual({
    ...flow,
    cancelled_at_ms: 1500,
  });
  expect(await cancelGuestRegistration(memory, flow.id, 2000)).toBeUndefined();
  memory.flow = bound;
  await expect(cancelGuestRegistration(memory, flow.id, 2000)).rejects.toMatchObject({
    code: "already_complete",
    status: 409,
  });
});
test("登録の資格とOAuthの期限・固定済みの本人を検証します", async () => {
  const memory = new MemoryRegistrations();
  expect(await registrationWithSecret(memory, flow.id, async () => "hash")).toEqual(flow);
  await expect(registrationWithSecret(memory, flow.id, async () => "wrong")).rejects.toMatchObject({
    code: "unauthorized",
    status: 401,
  });
  memory.flow = null;
  await expect(
    registrationWithSecret(memory, flow.id, async () => {
      throw new Error("must not hash");
    }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  memory.flow = { ...flow };
  expect(
    await prepareRegistrationOAuth(
      memory,
      flow.id,
      async () => "hash",
      () => 3600999,
    ),
  ).toEqual(flow);
  for (const patch of [{ player_id: null }, { cancelled_at_ms: 5000 }])
    expect(() => assertRegistrationOAuth({ ...flow, ...patch }, 5000)).toThrow(
      expect.objectContaining({ code: "expired", status: 410 }),
    );
  expect(() => assertRegistrationOAuth(flow, 3601000)).toThrow(
    expect.objectContaining({ code: "expired" }),
  );
  expect(() => assertRegistrationOAuth(bound, 5000)).toThrow(
    expect.objectContaining({ code: "account_mismatch" }),
  );
  expect(() => assertRegistrationSetup(flow, 3601000)).toThrow(
    expect.objectContaining({ code: "expired" }),
  );
});
test("プロフィールとsessionの一致を要求し、未認証・取消・未設定を区別します", () => {
  expect(assertRegistrationAccount(identity, bound, true)).toBe(identity);
  for (const [actual, saved, required, code] of [
    [null, bound, true, "unauthorized"],
    [identity, { ...bound, cancelled_at_ms: 1 }, true, "cancelled"],
    [{ ...identity, sessionId: "other" }, bound, true, "account_mismatch"],
    [{ ...identity, user: { ...user, id: "other" } }, bound, true, "account_mismatch"],
    [{ ...identity, user: { ...user, profileCompleted: 0 } }, bound, true, "profile_required"],
  ] as const)
    expect(() => assertRegistrationAccount(actual, saved, required)).toThrow(
      expect.objectContaining({ code }),
    );
  expect(
    assertRegistrationAccount({ ...identity, user: { ...user, profileCompleted: 0 } }, bound, false)
      .user.profileCompleted,
  ).toBe(0);
});
test("OAuthの保存競合と同意なしを拒否し、callbackの本人確認後だけ確定します", async () => {
  const memory = new MemoryRegistrations();
  await rememberRegistrationOAuth(memory, flow, "state", "google", 5000);
  memory.flow = bound;
  await expect(
    rememberRegistrationOAuth(memory, flow, "state", "google", 5000),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  await expect(requireRegistrationConsent(memory, user.id, "legal")).rejects.toMatchObject({
    code: "consent_required",
    status: 403,
  });
  memory.consent = true;
  await requireRegistrationConsent(memory, user.id, "legal");
  const ports = {
    now: () => 5000,
    acceptProvider: (provider: string) => provider === "google",
    identity: async () => {
      memory.events.push("identity");
      return identity;
    },
  };
  memory.events = [];
  await completeRegistrationOAuth(memory, "state", ports);
  expect(memory.events).toEqual(["pending", "identity", "complete"]);
  memory.events = [];
  await completeRegistrationOAuth(memory, "state", { ...ports, acceptProvider: () => false });
  expect(memory.events).toEqual(["pending"]);
  memory.events = [];
  await completeRegistrationOAuth(memory, "state", { ...ports, identity: async () => null });
  expect(memory.events).toEqual(["pending"]);
});
test("登録状況は本人・記録・席を独立して返し、完了した記録を期限切れに戻しません", () => {
  expect(registrationStatus(flow, null, null, { state: "pending" }, () => 5000)).toEqual({
    registrationId: "registration",
    roomId: "12345",
    instanceId: "instance",
    matchId: "match",
    playerId: "player",
    holdUntilMs: 601000,
    claimUntilMs: 3601000,
    identity: "unverified",
    record: "unclaimed",
    seat: "held",
  });
  for (const [state, expected] of [
    ["converted", "complete"],
    ["pending", "held"],
    ["cancelled", "cancelled"],
    ["expired", "expired"],
    ["released", "unavailable"],
  ])
    expect(registrationStatus(bound, identity, "applied", { state }, () => 3601000)).toMatchObject({
      identity: "ready",
      record: "complete",
      seat: expected,
    });
  for (const [state, expected] of [
    ["applied", "complete"],
    ["retired", "retired"],
    ["rejected", "conflict"],
    ["pending", "pending"],
    [null, "expired"],
  ])
    expect(registrationStatus(bound, null, state, null, () => 3601000)).toMatchObject({
      identity: "mismatch",
      record: expected,
      seat: "expired",
    });
  expect(
    registrationStatus(
      { ...bound, seat_state: "conflict" },
      identity,
      null,
      { state: "pending" },
      () => 5000,
    ).seat,
  ).toBe("conflict");
  expect(
    registrationStatus({ ...bound, seat_state: "complete" }, identity, null, null, () => 3601000)
      .seat,
  ).toBe("complete");
  expect(
    registrationStatus({ ...bound, cancelled_at_ms: 1 }, identity, null, null, () => 5000).seat,
  ).toBe("cancelled");
  expect(
    registrationStatus(
      bound,
      { ...identity, user: { ...user, profileCompleted: 0 } },
      null,
      null,
      () => 5000,
    ).identity,
  ).toBe("profile_required");
});
test("未確定・取消済みの状況取得では外部を照会せず、通常は本人→記録→席の順です", async () => {
  const events: string[] = [];
  const ports: RegistrationObservations = {
    identity: async () => {
      events.push("identity");
      return identity;
    },
    matchState: async () => {
      events.push("record");
      return "applied";
    },
    roomState: async () => {
      events.push("room");
      return { state: "converted" };
    },
    now: () => 5000,
  };
  for (const [cancelled_at_ms, code] of [
    [null, "preparing"],
    [1, "cancelled"],
  ] as const) {
    const pending: RegistrationFlow = { ...flow, player_id: null, cancelled_at_ms };
    await expect(getRegistrationStatus(pending, ports)).rejects.toMatchObject({ code });
    expect(events).toEqual([]);
  }
  expect(await getRegistrationStatus(bound, ports)).toMatchObject({
    identity: "ready",
    record: "complete",
    seat: "complete",
  });
  expect(events).toEqual(["identity", "record", "room"]);
});
