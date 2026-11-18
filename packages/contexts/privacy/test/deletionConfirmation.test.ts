import { expect, mock, test } from "bun:test";
import {
  confirmDeletion,
  readDeletionConfirmation,
  startDeletionChallenge,
  validDeletionReceipt,
  verifyDeletionReauthentication,
  type DeletionChallengeStarter,
} from "@tetraboard/context-privacy";

const now = () => 1_000_000;
const newId = () => "new-id";

function challengeStarter(count: number) {
  return {
    readFlowAccount: mock(async (): Promise<string | null> => "account"),
    countRecentChallenges: mock(async () => count),
    readProvider: mock(async () => "google" as const),
    createChallenge: mock(async () => true),
    createFlow: mock(async () => {}),
  } satisfies DeletionChallengeStarter;
}

test("直近1分の4件までは再認証を始め、5件では新しい確認を作らない", async () => {
  const starter = challengeStarter(4);
  const ids = ["flow", "challenge"];
  expect(await startDeletionChallenge(starter, "account", null, now, () => ids.shift()!)).toEqual({
    status: "started",
    flowId: "flow",
    challengeId: "challenge",
    provider: "google",
  });
  expect(starter.countRecentChallenges).toHaveBeenCalledWith("account", 940_000);
  expect(starter.createChallenge).toHaveBeenCalledWith(
    "challenge",
    "account",
    "google",
    now(),
    1_600_000,
  );
  expect(starter.createFlow).toHaveBeenCalledWith("flow", "account", 87_400_000);

  const limited = challengeStarter(5);
  expect(await startDeletionChallenge(limited, "account", null, now, newId)).toEqual({
    status: "rate_limited",
  });
  expect(limited.createChallenge).not.toHaveBeenCalled();
});

test.each([null, "other"])(
  "期限切れまたは別人の手続きでは再認証を始めない（%s）",
  async (owner) => {
    const store = challengeStarter(0);
    store.readFlowAccount.mockResolvedValueOnce(owner);
    expect(await startDeletionChallenge(store, "account", "flow", now, newId)).toEqual({
      status: "wrong_account",
    });
    expect(store.countRecentChallenges).not.toHaveBeenCalled();
    expect(store.createChallenge).not.toHaveBeenCalled();
  },
);

test("本人を切り替えた手続きでは確認済みの資格も席も返さない", async () => {
  const store = {
    readFlowAccount: async () => "other",
    isVerified: mock(async () => true),
    isSeated: mock(async () => true),
  };
  const session = mock(async () => "session");
  expect(
    await readDeletionConfirmation(store, "account", "flow", "challenge", session, now),
  ).toEqual({ verified: false, seated: false, changedAccount: true });
  expect(session).not.toHaveBeenCalled();
  expect(store.isSeated).not.toHaveBeenCalled();
});

test("退会受付に失敗しても確認を使い切り、再認証なしでは再試行できない", async () => {
  let verified = true;
  const store = {
    readFlowAccount: async () => "account",
    consumeChallenge: mock(async () => {
      const valid = verified;
      verified = false;
      return valid;
    }),
    requestDeletion: mock(async () => false),
  };
  const input = {
    accountId: "account",
    flowId: "flow",
    challengeId: "challenge",
    confirmed: async () => true,
    sessionId: async () => "session",
  };
  expect(await confirmDeletion(store, input, now, () => "receipt")).toEqual({ status: "rejected" });
  expect(await confirmDeletion(store, input, now, () => "receipt")).toEqual({
    status: "unverified",
  });
  expect(store.consumeChallenge).toHaveBeenCalledWith("challenge", "account", "session", now());
  expect(store.requestDeletion).toHaveBeenCalledTimes(1);
  expect(store.requestDeletion).toHaveBeenCalledWith("account", "receipt");
});

test("明示的な確認がないと再認証を消費しない", async () => {
  const store = {
    readFlowAccount: async () => "account",
    consumeChallenge: mock(async () => true),
    requestDeletion: mock(async () => true),
  };
  const input = {
    accountId: "account",
    flowId: "flow",
    challengeId: "challenge",
    confirmed: async () => false,
    sessionId: mock(async () => "session"),
  };
  expect(await confirmDeletion(store, input, now, newId)).toEqual({ status: "unconfirmed" });
  expect(input.sessionId).not.toHaveBeenCalled();
  expect(store.consumeChallenge).not.toHaveBeenCalled();
});

test.each([
  ["google", "account", now() - 1, false],
  ["google", "other", now(), false],
  ["discord", "account", now(), false],
  ["google", "account", now(), true],
] as const)(
  "再認証の照合（%s、%s、セッション作成時刻 %d）",
  async (provider, accountId, createdAtMs, accepted) => {
    const store = {
      readChallenge: mock(async () => ({
        accountId: "account",
        provider: "google",
        createdAtMs: now(),
      })),
      verifyChallenge: mock(async () => {}),
    };
    await verifyDeletionReauthentication(
      store,
      { challengeId: "challenge", state: "state", pathname: `/api/auth/callback/${provider}` },
      async () => ({ accountId, createdAtMs, id: "session" }),
      now,
    );
    expect(store.readChallenge).toHaveBeenCalledWith("challenge", "state", now());
    if (accepted)
      expect(store.verifyChallenge).toHaveBeenCalledWith("challenge", "state", "session", now());
    else expect(store.verifyChallenge).not.toHaveBeenCalled();
  },
);

test("退会の照会には既存の受付番号形式を使う", () => {
  const uuid = "10aa9918-c112-4210-9899-0123456789ab";
  expect(validDeletionReceipt(uuid + uuid)).toBe(true);
  expect(validDeletionReceipt(uuid)).toBe(false);
  expect(validDeletionReceipt(uuid.toUpperCase() + uuid)).toBe(false);
});
