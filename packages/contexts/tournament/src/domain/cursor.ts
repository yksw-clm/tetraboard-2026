export function cursorOffset(value?: string) {
  if (!value) return 0;
  if (value.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      typeof parsed === "number" &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 10_000_000
    )
      return parsed;
  } catch {
    /* invalid cursor */
  }
  return null;
}
export const nextOffset = (offset: number) => btoa(JSON.stringify(offset));
