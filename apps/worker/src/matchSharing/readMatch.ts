import { readMatchDetail } from "@tetraboard/context-record";
import { getPublicMatchContract } from "@tetraboard/protocol";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";
import { participantProfiles } from "../accounts/matchProfiles";

export async function readPublicShareMatch(db: D1Database, id: string) {
  const result = await readMatchDetail(
    new D1MatchReadStore(db),
    id,
    undefined,
    matchReadValidation,
    (records) => participantProfiles(db, records),
  );
  return result ? getPublicMatchContract.response.parse(result).match : null;
}
