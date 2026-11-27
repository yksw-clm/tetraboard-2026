import { readMatchDetail } from "@tetraboard/context-record";
import { getPublicMatchContract } from "@tetraboard/protocol";
import type { BoardAttachment } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import {
  eventReplayPositions,
  snapshotReplayPositions,
} from "@tetraboard/protocol/replay-positions";
import { D1MatchReadStore } from "../adapters/record/matchReadStore";
import { matchReadValidation } from "../adapters/record/readValidation";

export async function canAttachPosition(db: D1Database, game: GameId, attachment: BoardAttachment) {
  const result = await readMatchDetail(
    new D1MatchReadStore(db),
    attachment.matchId,
    undefined,
    matchReadValidation,
    async () => new Map(),
  );
  if (!result) return false;
  const { match } = getPublicMatchContract.response.parse(result);
  if (match.settings.game !== game) return false;
  const { replay } = match;
  const positions =
    replay && "eventCount" in replay
      ? eventReplayPositions(replay.eventCount)
      : snapshotReplayPositions(replay);
  return attachment.position < positions.length;
}
