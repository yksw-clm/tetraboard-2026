import { z } from "zod";

// TODO: 現在はhelathzしかないためindex.tsに記述しているが、次に新しいAPIを実装する時、healthzAPIも含めてファイルは適切に分割する
export const healthzContract = {
  method: "GET",
  path: "/healthz",
  response: z.strictObject({ status: z.literal("ok") }),
} as const;

export type HealthzResponse = z.infer<typeof healthzContract.response>;
