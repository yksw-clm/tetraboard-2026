import { cpuProfileRating, type CpuRatingReference } from "../domain/profileRatings";
import type { RatingGame } from "../domain/policy";
import type { RatingReader } from "./ports";
import { readBeforeRating } from "./queries";

type MatchProfileRatingInput<Saved> = {
  game: RatingGame;
  matchId: string;
  rated: boolean;
  saved?: Saved;
  player?:
    | { kind: "cpu"; reference?: CpuRatingReference }
    | {
        kind: "human";
        accountId: string | null;
        retired?: true;
      };
};

export async function readMatchProfileRating<Saved extends object>(
  reader: Pick<RatingReader, "before">,
  { game, matchId, rated, saved, player }: MatchProfileRatingInput<Saved>,
) {
  if (!rated || !player || (player.kind === "human" && player.retired)) return;
  if (saved) return saved;
  if (player.kind === "cpu") return cpuProfileRating(player.reference);
  if (player.accountId) return readBeforeRating(reader, game, matchId, player.accountId);
}
