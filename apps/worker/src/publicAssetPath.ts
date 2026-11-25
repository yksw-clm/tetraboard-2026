export function normalizePublicAssetPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");
    return new URL(decoded, "https://assets.invalid").pathname;
  } catch {
    return null;
  }
}
