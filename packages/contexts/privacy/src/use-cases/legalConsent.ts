import { acceptsLegalTerms, isCurrentLegalVersion } from "../domain/consent";
import { isProviderCallback } from "../domain/deletion";

export interface LegalConsentStore {
  readVersion(accountId: string): Promise<string | undefined>;
  saveConsent(accountId: string, version: string, acceptedAt: number): Promise<void>;
}

export async function readLegalConsent(
  store: Pick<LegalConsentStore, "readVersion">,
  accountId: string,
  currentVersion: string,
) {
  return {
    accepted: isCurrentLegalVersion(await store.readVersion(accountId), currentVersion),
    version: currentVersion,
  };
}

export async function acceptLegalConsent(
  store: Pick<LegalConsentStore, "saveConsent">,
  accountId: string,
  input: { version?: unknown; accepted?: unknown } | null,
  currentVersion: string,
  now: () => number,
) {
  if (!acceptsLegalTerms(input, currentVersion)) return null;
  await store.saveConsent(accountId, currentVersion, now());
  return { accepted: true, version: currentVersion };
}

export interface OAuthLegalConsentStore {
  readOAuthConsent(
    state: string,
    now: number,
  ): Promise<{ provider: string; version: string } | null>;
  completeOAuthConsent(accountId: string, state: string, version: string): Promise<void>;
}

export async function completeOAuthLegalConsent(
  store: OAuthLegalConsentStore,
  callback: { state: string; pathname: string },
  currentVersion: string,
  readAccountId: () => Promise<string | null>,
  now: () => number,
) {
  const { state, pathname } = callback;
  const flow = await store.readOAuthConsent(state, now());
  if (
    !flow ||
    !isCurrentLegalVersion(flow.version, currentVersion) ||
    !isProviderCallback(pathname, flow.provider)
  )
    return;
  const accountId = await readAccountId();
  if (accountId !== null) await store.completeOAuthConsent(accountId, state, currentVersion);
}
