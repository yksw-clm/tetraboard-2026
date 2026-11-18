import {
  deletionChallengeLifetimeMs,
  deletionChallengeWindowMs,
  deletionFlowLifetimeMs,
  tooManyDeletionChallenges,
  type DeletionProvider,
} from "../domain/deletion";

export interface DeletionFlowReader {
  readFlowAccount(flowId: string, now: number): Promise<string | null>;
}

export interface DeletionChallengeStarter extends DeletionFlowReader {
  countRecentChallenges(accountId: string, createdAfter: number): Promise<number>;
  readProvider(accountId: string): Promise<DeletionProvider | null>;
  createChallenge(
    id: string,
    accountId: string,
    provider: DeletionProvider,
    now: number,
    expiresAt: number,
  ): Promise<boolean>;
  createFlow(id: string, accountId: string, expiresAt: number): Promise<void>;
}

export async function startDeletionChallenge(
  store: DeletionChallengeStarter,
  accountId: string,
  suppliedFlow: string | null,
  now: () => number,
  newId: () => string,
) {
  if (suppliedFlow && (await store.readFlowAccount(suppliedFlow, now())) !== accountId)
    return { status: "wrong_account" } as const;

  const flowId = suppliedFlow ?? newId();
  const count = await store.countRecentChallenges(accountId, now() - deletionChallengeWindowMs);
  if (tooManyDeletionChallenges(count)) return { status: "rate_limited" } as const;
  const provider = await store.readProvider(accountId);
  if (!provider) return { status: "no_provider" } as const;

  const challengeId = newId();
  const createdAt = now();
  const inserted = await store.createChallenge(
    challengeId,
    accountId,
    provider,
    createdAt,
    createdAt + deletionChallengeLifetimeMs,
  );
  if (!inserted) return { status: "rate_limited" } as const;
  if (!suppliedFlow) await store.createFlow(flowId, accountId, now() + deletionFlowLifetimeMs);
  return { status: "started", flowId, challengeId, provider } as const;
}

type ChallengeLookup = (
  challengeId: string,
  accountId: string,
  sessionId: string,
  now: number,
) => Promise<boolean>;

interface DeletionConfirmationReader extends DeletionFlowReader {
  isVerified: ChallengeLookup;
  isSeated(accountId: string): Promise<boolean>;
}

export async function readDeletionConfirmation(
  store: DeletionConfirmationReader,
  accountId: string,
  flowId: string,
  challengeId: string,
  sessionId: () => Promise<string>,
  now: () => number,
) {
  const flowAccount = await store.readFlowAccount(flowId, now());
  if (flowAccount !== null && flowAccount !== accountId)
    return { verified: false, seated: false, changedAccount: true } as const;
  const verified = await store.isVerified(challengeId, accountId, await sessionId(), now());
  const seated = await store.isSeated(accountId);
  return { verified, seated };
}

interface DeletionConfirmationWriter extends DeletionFlowReader {
  consumeChallenge: ChallengeLookup;
  requestDeletion(accountId: string, receipt: string): Promise<boolean>;
}

export async function confirmDeletion(
  store: DeletionConfirmationWriter,
  request: {
    accountId: string;
    flowId: string;
    challengeId: string;
    confirmed: () => Promise<boolean>;
    sessionId: () => Promise<string>;
  },
  now: () => number,
  newReceipt: () => string,
) {
  const { accountId, flowId, challengeId } = request;
  if ((await store.readFlowAccount(flowId, now())) !== accountId)
    return { status: "wrong_account" } as const;
  if (!(await request.confirmed())) return { status: "unconfirmed" } as const;
  if (!(await store.consumeChallenge(challengeId, accountId, await request.sessionId(), now())))
    return { status: "unverified" } as const;

  const receipt = newReceipt();
  if (!(await store.requestDeletion(accountId, receipt))) return { status: "rejected" } as const;
  return { status: "accepted", receipt } as const;
}
