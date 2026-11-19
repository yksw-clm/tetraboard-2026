import { z } from "zod";
import { hasIdentityCookie } from "../adapters/account/auth";

export const chatPageQuery = z.object({
  before: z
    .string()
    .regex(/^\d{1,16}:[0-9a-f-]{36}$/)
    .refine(
      (v) =>
        Number.isSafeInteger(Number(v.split(":")[0])) &&
        z.uuid().safeParse(v.split(":")[1]).success,
    )
    .optional(),
  limit: z.coerce.number().int().min(50).max(500).default(50),
});

export function canReadTournamentChatAnonymously(path: string, request: Request) {
  return (
    request.method === "GET" &&
    /^(?:\/api)?\/tournaments\/[^/]+\/chat$/.test(path) &&
    !hasIdentityCookie(request)
  );
}
