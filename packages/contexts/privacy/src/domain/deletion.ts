export const deletionChallengeWindowMs = 60_000;
export const deletionChallengeLifetimeMs = 600_000;
export const deletionFlowLifetimeMs = 86_400_000;
export const deletionAvatarUploadWindowMs = 600_000;
export const deletionJobLimit = 10;
export const deletionRoomLimit = 100;

export type DeletionProvider = "google" | "discord";

export function tooManyDeletionChallenges(count: number): boolean {
  return count >= 5;
}

export function validDeletionReceipt(receipt: unknown): receipt is string {
  return typeof receipt === "string" && /^([0-9a-f-]{36}){2}$/.test(receipt);
}

export function isProviderCallback(pathname: string, provider: string): boolean {
  return pathname.endsWith(`/callback/${provider}`);
}

export function matchesDeletionSession(
  challenge: { accountId: string; createdAtMs: number },
  session: { accountId: string; createdAtMs: number },
): boolean {
  return (
    session.accountId === challenge.accountId && !(session.createdAtMs < challenge.createdAtMs)
  );
}
