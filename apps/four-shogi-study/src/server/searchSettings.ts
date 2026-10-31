/** 未指定なら従来のメモリ・worker数から決まる上限を維持します。 */
export function readStudyCacheEnvironment(env: Record<string, string | undefined>) {
  const raw = env.STUDY_SEARCH_CACHE_ENTRIES;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < 0 || value > 65536)
    throw new Error("STUDY_SEARCH_CACHE_ENTRIESは0〜65536の整数です");
  return value;
}
