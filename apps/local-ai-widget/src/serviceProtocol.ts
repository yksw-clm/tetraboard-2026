import { z } from "zod";

export const nativeHostName = "net.tetraboard.local_ai";
export const serviceCommandSchema = z.enum(["status", "start", "stop", "restart"]);
export type ServiceCommand = z.infer<typeof serviceCommandSchema>;
export const serviceStateSchema = z.enum(["stopped", "running", "external"]);
export type ServiceState = z.infer<typeof serviceStateSchema>;
export const nativeRequestSchema = z
  .object({ id: z.uuid(), command: serviceCommandSchema })
  .strict();
export const nativeResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.uuid(),
      protocol_version: z.literal(1),
      ok: z.literal(true),
      state: serviceStateSchema,
      token: z.string().min(32).max(256).optional(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      protocol_version: z.literal(1),
      ok: z.literal(false),
      error: z.string().max(500),
    })
    .strict(),
]);
export type NativeResponse = z.infer<typeof nativeResponseSchema>;
