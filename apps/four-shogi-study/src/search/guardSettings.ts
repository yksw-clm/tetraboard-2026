import type { LethalGuardOptions, LethalGuardMode, GuardSelection } from "./lethalGuard";
import type { GuardReplyOrdering } from "./guardReplyOrder";
import type { GuardBudgetPolicy } from "./guardBudget";

export function readLethalGuardEnvironment(
  env: Record<string, string | undefined>,
): LethalGuardOptions {
  const mode = env.STUDY_LETHAL_GUARD_MODE ?? "off";
  const budgetMs = Number(env.STUDY_LETHAL_GUARD_MS ?? 250);
  const selection = env.STUDY_LETHAL_GUARD_SELECTION ?? "top3-reserve";
  const replyOrdering = env.STUDY_LETHAL_GUARD_ORDER ?? "base";
  const budgetPolicy = env.STUDY_LETHAL_GUARD_BUDGET ?? "fixed-50";
  if (
    !["off", "observe", "experimental"].includes(mode) ||
    !["top3", "top5", "top3-reserve"].includes(selection) ||
    !["base", "simple", "checks"].includes(replyOrdering) ||
    !["fixed-50", "incumbent", "reserve", "progress"].includes(budgetPolicy) ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 5000
  )
    throw Error(
      "致命応手ガードはoff/observe/experimental、予算1〜5000ms、選別top3/top5/top3-reserveです",
    );
  return {
    mode: mode as LethalGuardMode,
    budgetMs,
    selection: selection as GuardSelection,
    replyOrdering: replyOrdering as GuardReplyOrdering,
    budgetPolicy: budgetPolicy as GuardBudgetPolicy,
  };
}
