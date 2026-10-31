import { createPvFocusRuntime } from "./focusRuntime";
import { createPonderFocusRuntime } from "./ponderRuntime";
import { createStudySearchRuntime, type StudySearchRuntimeConfig } from "./runtime";
export type FocusReuseSettings = {
  mode: "off" | "pv" | "ponder" | "combined";
  ponderMs: number;
  ttlMs: number;
  cacheEntries: number;
};
export function readFocusReuseEnvironment(
  env: Record<string, string | undefined>,
): FocusReuseSettings {
  const mode = env.STUDY_FOCUS_REUSE ?? "off",
    ponderMs = Number(env.STUDY_PONDER_MS ?? 1000),
    ttlMs = Number(env.STUDY_FOCUS_TTL_MS ?? 30000),
    cacheEntries = Number(env.STUDY_FOCUS_CACHE_ENTRIES ?? 1024);
  if (
    !["off", "pv", "ponder", "combined"].includes(mode) ||
    !Number.isFinite(ponderMs) ||
    ponderMs < 1 ||
    ponderMs > 60000 ||
    !Number.isFinite(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 300000 ||
    !Number.isSafeInteger(cacheEntries) ||
    cacheEntries < 0 ||
    cacheEntries > 65536
  )
    throw Error(
      "フォーカス引継ぎはoff/pv/ponder/combined、先読み1〜60000ms、保持1〜300000ms、cache0〜65536件です",
    );
  return { mode: mode as FocusReuseSettings["mode"], ponderMs, ttlMs, cacheEntries };
}
export function createFocusReuseRuntime(
  config: StudySearchRuntimeConfig,
  settings: FocusReuseSettings,
) {
  return settings.mode === "off"
    ? createStudySearchRuntime(config)
    : settings.mode === "pv"
      ? createPvFocusRuntime(config)
      : createPonderFocusRuntime(config, { ...settings, mode: settings.mode });
}
