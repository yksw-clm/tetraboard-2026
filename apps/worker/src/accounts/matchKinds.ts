import { readMatchKinds as readKinds } from "../adapters/record/matchKinds";
import type { ReadableMatch } from "./matchDataContracts";
export { withMatchKind } from "@tetraboard/context-record";
export { matchHistoryFilterSql } from "../adapters/record/matchKinds";
export function readMatchKinds(db: D1Database, records: readonly ReadableMatch[]) {
  return readKinds(
    db,
    records.map(({ record }) => record.id),
  );
}
