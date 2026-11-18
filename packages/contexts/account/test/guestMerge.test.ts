import { expect, test } from "bun:test";
import {
  GuestLinkError,
  mergeGuestAccounts,
  prepareGuestLinkClaim,
  promoteGuestLink,
  rememberGuestLink,
  requireGuestIdle,
  type GuestLinkClaimStore,
  type GuestMergeChecks,
  type GuestMergeFlow,
  type GuestMergeWrites,
  type GuestOAuthRecord,
  type GuestPromotionChecks,
  type GuestPromotionWrites,
  type RegistrationFlow,
} from "../src";
import { user } from "./fixtures";
import { flow as registrationFlow } from "./registrationFixtures";

const flow: GuestMergeFlow = {
  state: "oauth",
  guest_id: "guest",
  target_id: "target",
  target_session_id: "session",
  name: "ゲスト",
  is_new_target: 0,
};
const roomFlow = { ...flow, room_registration_id: registrationFlow.id };
const now = 2000;
const nowIso = "1970-01-01T00:00:02.000Z";

class MemoryGuestChecks implements GuestMergeChecks, GuestPromotionChecks {
  busy = new Set<string>();
  rooms = new Map([
    ["12345", false],
    ["67890", false],
  ]);
  registration: RegistrationFlow | null = { ...registrationFlow, guest_account_id: "guest" };
  roomState = "pending";
  hash: string | null = "hash";
  target: { email: string } | null = { email: "target@example.com" };
  async guestBusy(id: string) {
    return this.busy.has(id);
  }
  async roomsForAccount() {
    return [...this.rooms.keys()];
  }
  async roomMergeConflict(roomId: string) {
    return this.rooms.get(roomId) ?? false;
  }
  async readRegistration(id: string) {
    return this.registration?.id === id ? this.registration : null;
  }
  async roomRegistration() {
    return { state: this.roomState };
  }
  async tokenHash() {
    return this.hash;
  }
  async targetEmail() {
    return this.target;
  }
  now() {
    return now;
  }
  nowIso() {
    return nowIso;
  }
}

const writes: GuestMergeWrites<string> & GuestPromotionWrites<string> = {
  commitRoomLink: (id, link, time) => `commit:${id}:${link.state}:${time}`,
  releaseRoomLink: (id) => `release:${id}`,
  recordMerge: (guest, target, time) => `merge:${guest}:${target}:${time}`,
  retireGuest: () => ["retire"],
  acceptRoomRecord: (id, target, time) => `accept:${id}:${target}:${time}`,
  recordPromotion: (link, hash, time) =>
    `promotion:${link.guest_id}:${link.target_id}:${link.target_session_id}:${hash}:${time}`,
  releaseTemporaryEmail: (target) => `release-email:${target}`,
  promoteGuest: (link, email, hash, clock) =>
    `promote:${link.guest_id}:${email}:${hash}:${clock.now()}:${clock.nowIso()}`,
  transferProviderAndSessions: () => ["provider", "sessions"],
  transferRegistration: (id, link) => `registration:${id}:${link.target_session_id}`,
  deleteTemporaryUser: (target) => `delete:${target}`,
  retirePromotedGuestCredentials: () => ["retire-credentials"],
};

test("待機・席のないゲストは連携を続けられる", async () => {
  await expect(requireGuestIdle(new MemoryGuestChecks(), "guest")).resolves.toBeUndefined();
});

test("使用中の席や待機があるゲストの連携を止める", async () => {
  const checks = new MemoryGuestChecks();
  checks.busy.add("guest");
  await expect(requireGuestIdle(checks, "guest")).rejects.toThrow(GuestLinkError);
});

test("同じ対局の複数席を統合できない", async () => {
  const checks = new MemoryGuestChecks();
  checks.rooms.set("67890", true);
  await expect(mergeGuestAccounts(checks, writes, flow)).rejects.toThrow(
    "同じ対局で参加した複数の席の記録は統合できません。",
  );
});

test.each(["期限切れ", "取消済み", "別ゲスト", "DOで保持終了"])(
  "統合は保持席を使えない場合にゲストの待機を拒否する（%s）",
  async (reason) => {
    const checks = new MemoryGuestChecks();
    checks.busy.add("guest");
    if (reason === "期限切れ") checks.registration!.hold_until_ms = now;
    if (reason === "取消済み") checks.registration!.cancelled_at_ms = now;
    if (reason === "別ゲスト") checks.registration!.guest_account_id = "other";
    if (reason === "DOで保持終了") checks.roomState = "converted";
    await expect(mergeGuestAccounts(checks, writes, roomFlow)).rejects.toThrow("待機を取り消して");
  },
);

test("通常の統合はフェンスの記録を先頭にして書き込みを返す", async () => {
  const plan = await mergeGuestAccounts(new MemoryGuestChecks(), writes, flow);
  expect(plan.held).toBeNull();
  expect(plan.initialWrites).toEqual(["merge:guest:target:2000"]);
  expect(plan.prepareFinalWrites()).toEqual(["retire"]);
});

test("保持席の統合はフェンスの書き込み、保持席、ゲスト資格と登録の最終書き込みを返す", async () => {
  const checks = new MemoryGuestChecks();
  checks.busy.add("guest");
  const plan = await mergeGuestAccounts(checks, writes, roomFlow);
  expect(plan.held).toEqual(checks.registration);
  expect(plan.initialWrites).toEqual(["commit:registration:oauth:2000", "merge:guest:target:2000"]);
  expect(plan.prepareFinalWrites()).toEqual([
    "retire",
    "accept:registration:target:2000",
    "release:registration",
  ]);
});

test.each(["guest", "target"])("昇格は待機中の %s を拒否する", async (id) => {
  const checks = new MemoryGuestChecks();
  checks.busy.add(id);
  await expect(promoteGuestLink(checks, writes, flow)).rejects.toThrow("待機を取り消して");
});

test("昇格は保持席があっても連携先の待機を拒否する", async () => {
  const checks = new MemoryGuestChecks();
  checks.busy.add("target");
  await expect(promoteGuestLink(checks, writes, roomFlow)).rejects.toThrow("待機を取り消して");
});

test.each(["hash", "target"] as const)(
  "昇格は本人確認に必要な %s がなければ拒否する",
  async (key) => {
    const checks = new MemoryGuestChecks();
    checks[key] = null;
    await expect(promoteGuestLink(checks, writes, flow)).rejects.toThrow(
      "連携の本人確認をやり直してください。",
    );
  },
);

const promotionWrites = [
  "promotion:guest:target:session:hash:2000",
  "release-email:target",
  "promote:guest:target@example.com:hash:2000:1970-01-01T00:00:02.000Z",
  "provider",
  "sessions",
];

test("通常の昇格はフェンスから一時アカウントとゲスト資格の整理まで順に返す", async () => {
  expect(await promoteGuestLink(new MemoryGuestChecks(), writes, flow)).toEqual([
    ...promotionWrites,
    "delete:target",
    "retire-credentials",
  ]);
});

test("保持席の昇格はルームのフェンスと登録先の更新を順序どおりに返す", async () => {
  const checks = new MemoryGuestChecks();
  checks.busy.add("guest");
  expect(await promoteGuestLink(checks, writes, roomFlow)).toEqual([
    "commit:registration:oauth:2000",
    ...promotionWrites,
    "registration:registration:session",
    "delete:target",
    "retire-credentials",
    "release:registration",
  ]);
});

test("OAuth開始の記録にゲストの資格・保持席・10分の有効期限を付ける", async () => {
  const records: GuestOAuthRecord[] = [];
  await rememberGuestLink(
    {
      remember: async (record) => {
        records.push(record);
      },
    },
    new MemoryGuestChecks(),
    "guest",
    "oauth",
    "google",
    "registration",
  );
  expect(records).toEqual([
    {
      state: "oauth",
      guestId: "guest",
      tokenHash: "hash",
      provider: "google",
      startedAt: now,
      expiresAt: now + 600_000,
      roomRegistrationId: "registration",
    },
  ]);
});

test("保持席のOAuth完了は認証の取得と登録先の固定に使う書き込みを返す", async () => {
  const store: GuestLinkClaimStore<string> = {
    pending: async () => ({
      guest_id: "guest",
      provider: "google",
      started_at_ms: now,
      room_registration_id: "registration",
    }),
    ensurePublicProfileId: async () => {},
    targetCreated: async () => ({ createdAt: nowIso }),
    claim: (link, expiresAt) => `claim:${link.state}:${link.target_id}:${expiresAt}`,
    fixRoomRegistration: (id, link) => `fix:${id}:${link.target_session_id}`,
  };
  const prepared = await prepareGuestLinkClaim(
    store,
    {
      tokenHash: async () => "hash",
      identity: async () => ({
        user: { ...user, id: "target", profileCompleted: 0 },
        sessionId: "session",
      }),
      suspendGuestSession: async () => {},
      acceptProvider: (provider) => provider === "google",
      now: () => now,
      id: () => "public-profile",
    },
    "oauth",
  );
  expect(prepared).toEqual({
    flow: { ...roomFlow, name: "", is_new_target: 1 },
    claim: "claim:oauth:target:3602000",
    roomClaim: "fix:registration:session",
  });
});
