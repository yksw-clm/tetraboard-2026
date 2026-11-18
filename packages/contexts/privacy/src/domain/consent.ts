export const oauthLegalConsentLifetimeMs = 600_000;

export function isCurrentLegalVersion(version: unknown, currentVersion: string): boolean {
  return version === currentVersion;
}

export function acceptsLegalTerms(
  input: { version?: unknown; accepted?: unknown } | null,
  currentVersion: string,
): boolean {
  return isCurrentLegalVersion(input?.version, currentVersion) && input?.accepted === true;
}
