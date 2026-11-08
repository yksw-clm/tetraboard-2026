import { z } from "zod";

// levelはRust profileの強さの識別子です。旧CPUのlevel 1/2とは分けて保持します。
export const cpuProfileSchema = z.strictObject({
  id: z.enum(["lv1-v1", "lv2-v1", "lv3-v1", "lv4-v1", "lv5-v1"]),
  engineVersion: z.string().min(1).max(40),
  rulesetVersion: z.literal("four-reversi-singles-v2"),
  stateVersion: z.literal(2),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: z.string().min(1).max(80),
  level: z.int().min(1).max(5),
  name: z.string().min(1).max(10),
  style: z.string().min(1).max(80),
});
export type CpuProfile = z.infer<typeof cpuProfileSchema>;
