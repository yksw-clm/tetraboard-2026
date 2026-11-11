import { shogiRatingResultSchema } from "@tetraboard/protocol";
import { createEloRating } from "./eloRating";
export {
  eloInitialRating as shogiInitialRating,
  eloRatingSourceSchema as shogiRatingSourceSchema,
  type EloRatingSource as ShogiRatingSource,
} from "./eloRating";

export const {
  store: shogiRatingStore,
  readResult: readShogiRatingResult,
  readPublic: readPublicShogiRating,
  readSummary: readShogiRatingSummary,
  statement: shogiRatingStatement,
} = createEloRating("shogi", shogiRatingResultSchema);
