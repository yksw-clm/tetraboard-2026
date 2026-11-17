import { readPublicMatchMetadata } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { readStoredMatch } from "../accounts/matchDataContracts";

export function readPublicShareMetadata(db: D1Database, id: string) {
  return readPublicMatchMetadata(new D1MatchReadStore(db), id, readStoredMatch);
}
