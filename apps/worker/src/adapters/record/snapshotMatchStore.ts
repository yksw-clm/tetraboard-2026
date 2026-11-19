import { readMatchDetailRecord as readDetail } from "@tetraboard/context-record";
import { D1MatchReadStore } from "./matchReadStore";
import { matchReadValidation } from "./readValidation";
export function readMatchDetailRecord(db: D1Database, json: string, game: string) {
  return readDetail(new D1MatchReadStore(db), { record_json: json, game }, matchReadValidation);
}
