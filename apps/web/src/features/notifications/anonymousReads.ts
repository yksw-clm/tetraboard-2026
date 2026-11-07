export type AnonymousReads = { through: number; ids: number[] };
const key = "tetraboard:notification-reads";
let fallback: AnonymousReads | null = null;
let memoryOnly = false;
export function loadAnonymousReads(): { state: AnonymousReads | null; storageError: boolean } {
  try {
    if (memoryOnly) return { state: fallback, storageError: true };
    const raw = localStorage.getItem(key);
    if (!raw) return { state: null, storageError: false };
    const parsed = JSON.parse(raw) as AnonymousReads;
    if (
      !Number.isSafeInteger(parsed.through) ||
      parsed.through < 0 ||
      !Array.isArray(parsed.ids) ||
      !parsed.ids.every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error("Invalid read state");
    fallback = parsed;
    return { state: parsed, storageError: false };
  } catch {
    return { state: fallback, storageError: true };
  }
}
export function saveAnonymousReads(state: AnonymousReads): boolean {
  fallback = state;
  try {
    localStorage.setItem(key, JSON.stringify(state));
    memoryOnly = false;
    return true;
  } catch {
    memoryOnly = true;
    return false;
  }
}
export function isAnonymousRead(state: AnonymousReads, id: number, legacy: boolean) {
  return legacy || id <= state.through || state.ids.includes(id);
}
