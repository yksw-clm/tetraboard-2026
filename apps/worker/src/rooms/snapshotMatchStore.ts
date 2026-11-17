import { readMatchDetailRecord as readDetail } from "@tetraboard/context-record";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";
export function readMatchDetailRecord(db: D1Database, json: string, game: string) {
  return readDetail(new D1MatchReadStore(db), { record_json: json, game }, matchReadValidation);
}
