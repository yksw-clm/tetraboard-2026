import { z } from "zod";
import registry from "../../../../packages/ai/configs/profiles-v1.json";

export const profileIdSchema = z.enum(["lv1-v1", "lv2-v1", "lv3-v1", "lv4-v1", "lv5-v1"]);
export const profileLimitsSchema = z.strictObject({
  max_iterations: z.int().min(1).max(4096).optional(),
  max_nodes: z.int().min(1).max(65536).optional(),
  max_time_ms: z.int().min(1).max(500).optional(),
});
const chosenProfileSchema = z.strictObject({
  profile_id: profileIdSchema,
  profile_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  limits: profileLimitsSchema.optional(),
});
export const serviceProfileSchema = z.union([
  chosenProfileSchema,
  z.strictObject({ configuration_error: z.literal(true) }),
]);
export type ServiceProfile = z.infer<typeof serviceProfileSchema>;

export function sameServiceProfile(
  a: ServiceProfile | undefined,
  b: ServiceProfile | undefined,
): boolean {
  if (!a || !b) return a === b;
  if ("configuration_error" in a || "configuration_error" in b)
    return "configuration_error" in a && "configuration_error" in b;
  return (
    a.profile_id === b.profile_id &&
    a.profile_hash === b.profile_hash &&
    (["max_iterations", "max_nodes", "max_time_ms"] as const).every(
      (key) => a.limits?.[key] === b.limits?.[key],
    )
  );
}

export function profileMetadata(id: z.infer<typeof profileIdSchema>) {
  return registry.profiles.find((p) => p.id === id)!;
}

export function expectedProfileLimits(selected: z.infer<typeof chosenProfileSchema>) {
  const profile = profileMetadata(selected.profile_id);
  const config = profile.config as {
    agent_id: string;
    budget?: { max_iterations?: number; max_nodes: number };
  };
  if (!config.budget) {
    if (selected.limits !== undefined) throw Error("対象外の予算です");
    return null;
  }
  const limits =
    config.agent_id === "four-reversi-mcts-v1"
      ? {
          max_iterations: config.budget.max_iterations,
          max_nodes: config.budget.max_nodes,
          max_time_ms: undefined as number | undefined,
        }
      : {
          max_iterations: undefined,
          max_nodes: config.budget.max_nodes,
          max_time_ms: undefined as number | undefined,
        };
  for (const key of ["max_iterations", "max_nodes", "max_time_ms"] as const) {
    const value = selected.limits?.[key];
    if (value === undefined) continue;
    if (key === "max_time_ms") {
      if (config.agent_id !== "four-reversi-mcts-v1") throw Error("対象外の時間予算です");
    } else if (limits[key] === undefined || value > limits[key])
      throw Error("profileの予算を増やせません");
    limits[key] = value;
  }
  return limits;
}

export function serviceProfile(bindings: {
  AI_SERVICE_LEVEL2_PROFILE?: string;
  AI_SERVICE_LEVEL2_LIMITS?: string;
}): ServiceProfile | undefined {
  if (!bindings.AI_SERVICE_LEVEL2_PROFILE && !bindings.AI_SERVICE_LEVEL2_LIMITS) return undefined;
  try {
    const selected = chosenProfileSchema.parse({
      profile_id: bindings.AI_SERVICE_LEVEL2_PROFILE,
      ...(bindings.AI_SERVICE_LEVEL2_LIMITS
        ? { limits: JSON.parse(bindings.AI_SERVICE_LEVEL2_LIMITS) }
        : {}),
    });
    expectedProfileLimits(selected);
    return { ...selected, profile_hash: profileMetadata(selected.profile_id).profile_hash };
  } catch {
    return { configuration_error: true };
  }
}
