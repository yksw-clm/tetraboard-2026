import { z } from "zod";

export const adminSessionSchema = z.object({ name: z.string(), username: z.string().nullable() });
export const adminSessionContract = {
  method: "GET",
  path: "/api/admin/session",
  response: adminSessionSchema,
} as const;
