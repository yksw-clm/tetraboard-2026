// フェーズ3の room の殻（TB-68）で、版の番号を付けた読み込み時の移行に置き換えます。
export function normalizeLegacyReversiState(
  value: unknown,
  readReplayId: () => string | undefined,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("settings" in value))
    return value;
  const settings = value.settings;
  if (
    !settings ||
    typeof settings !== "object" ||
    !("game" in settings) ||
    settings.game !== "reversi"
  )
    return value;
  const restored: Record<string, unknown> = { ...value };
  if (!Object.hasOwn(value, "roundId")) {
    restored.roundId = "status" in value && value.status === "waiting" ? null : readReplayId();
  }
  if (!Object.hasOwn(value, "positionRevision")) restored.positionRevision = 0;
  return restored;
}
