import { isProviderCallback, matchesDeletionSession } from "../domain/deletion";

export interface DeletionReauthenticationStore {
  readChallenge(
    id: string,
    state: string | null,
    now: number,
  ): Promise<{ accountId: string; provider: string; createdAtMs: number } | null>;
  verifyChallenge(id: string, state: string | null, sessionId: string, now: number): Promise<void>;
}

export async function verifyDeletionReauthentication(
  store: DeletionReauthenticationStore,
  callback: { challengeId: string; state: string | null; pathname: string },
  readSession: () => Promise<{ accountId: string; id: string; createdAtMs: number } | null>,
  now: () => number,
) {
  const { challengeId, state, pathname } = callback;
  const challenge = await store.readChallenge(challengeId, state, now());
  if (!challenge || !isProviderCallback(pathname, challenge.provider)) return;
  const session = await readSession();
  if (!session || !matchesDeletionSession(challenge, session)) return;
  await store.verifyChallenge(challengeId, state, session.id, now());
}
