import { reversiRatingResultSchema } from "@tetraboard/protocol";
import { createEloRating } from "./eloRating";

export const {
  store: reversiRatingStore,
  readResult: readReversiRatingResult,
  readPublic: readPublicReversiRating,
  readSummary: readReversiRatingSummary,
} = createEloRating("reversi", reversiRatingResultSchema);
