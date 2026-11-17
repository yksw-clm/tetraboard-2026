import type { MatchReadValidation } from "@tetraboard/context-record";
import {
  readStoredMatch,
  readMatchRecord,
  type DecodedMatch,
  type ReplayedMatch,
} from "../../accounts/matchDataContracts";
import { matchEventSchema, rebuildSnapshotMatch } from "../../rooms/snapshotMatchEvents";
export const matchReadValidation: MatchReadValidation<DecodedMatch, ReplayedMatch> = {
  readStored: readStoredMatch,
  readComplete: readMatchRecord,
  rebuildMatch: rebuildSnapshotMatch,
  parseEvent(game, event) {
    if (game === "shogi" || game === "four-shogi") throw new Error("Expected snapshot game");
    return matchEventSchema(game).parse(event);
  },
};
