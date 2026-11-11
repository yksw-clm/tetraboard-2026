import builtin from "../../../packages/ai/configs/profiles-v1.json";
import local from "../../../packages/ai/configs/local-analysis-profiles-v1.json";

export const localProfileIds = ["lv5-v1", "lv6-candidate-a-v1"] as const;
export type LocalProfileId = (typeof localProfileIds)[number];
export const profileNames: Record<LocalProfileId, string> = {
  "lv5-v1": "Lv5 ノヴァ",
  "lv6-candidate-a-v1": "Lv6",
};
export function localProfile(id: LocalProfileId) {
  const profile = [...builtin.profiles, ...local.profiles].find((p) => p.id === id);
  const budget = profile?.config.budget;
  if (
    !profile ||
    !budget ||
    typeof budget.max_iterations !== "number" ||
    typeof budget.max_nodes !== "number"
  )
    throw Error("ローカルprofileが見つかりません");
  return {
    hash: profile.profile_hash,
    limits: {
      max_iterations: budget.max_iterations,
      max_nodes: budget.max_nodes,
      max_time_ms: 2000 as const,
    },
  };
}
