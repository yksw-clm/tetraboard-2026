// 2026-10-03より前の引分提案がない状態がDOに残っている可能性があるため、保存状態の入口だけで補います。
// フェーズ3の殻では、版番号を付けて読み込み時に1回だけ移行する方式に置き換えます。
export function normalizeLegacyShogiState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("settings" in value))
    return value;
  const settings = value.settings;
  if (
    !settings ||
    typeof settings !== "object" ||
    !("game" in settings) ||
    (settings.game !== "four-shogi" && settings.game !== "shogi")
  )
    return value;
  const restored: Record<string, unknown> = { ...value };
  const containers = [restored];
  const lastRound = restored.lastRound;
  if (lastRound && typeof lastRound === "object" && !Array.isArray(lastRound)) {
    const round = { ...lastRound };
    restored.lastRound = round;
    containers.push(round);
  }
  let changed = false;
  for (const container of containers) {
    const game = container.game;
    if (
      game &&
      typeof game === "object" &&
      !Array.isArray(game) &&
      !Object.hasOwn(game, "drawProposals")
    ) {
      container.game = { ...game, drawProposals: [] };
      changed = true;
    }
  }
  return changed ? restored : value;
}
