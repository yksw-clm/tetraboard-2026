import { z } from "zod";

export const healthzContract = {
  method: "GET",
  path: "/healthz",
  response: z.strictObject({ status: z.literal("ok") }),
} as const;

export type HealthzResponse = z.infer<typeof healthzContract.response>;
