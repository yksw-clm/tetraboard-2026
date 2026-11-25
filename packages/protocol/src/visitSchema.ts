import { z } from "zod";
import { visitContract, type VisitInput } from "./visits";

const utmSchema = z.string().max(visitContract.maxUtmLength).nullable();

export const visitInputSchema = z.strictObject({
  path: z.string().startsWith("/").max(visitContract.maxPathLength),
  referrerHost: z.string().max(visitContract.maxReferrerHostLength).nullable(),
  utmSource: utmSchema,
  utmMedium: utmSchema,
  utmCampaign: utmSchema,
}) satisfies z.ZodType<VisitInput>;
