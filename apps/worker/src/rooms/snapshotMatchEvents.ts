import { reversiDefinition } from "@tetraboard/reversi/definition";
import { fourReversiDefinition } from "@tetraboard/four-reversi/definition";
import { gomokuDefinition } from "@tetraboard/gomoku/definition";
import { fourGomokuDefinition } from "@tetraboard/four-gomoku/definition";
import {
  reversiReplaySchema,
  roundReplaySchema,
  gomokuReplaySchema,
  fourGomokuReplaySchema,
} from "@tetraboard/protocol";
import { z } from "zod";
import type { MatchRecord as Reversi } from "./reversiMatchStore";
import type { MatchRecord as FourReversi } from "./matchStore";
import type { MatchRecord as Gomoku } from "./gomokuMatchStore";
import type { MatchRecord as FourGomoku } from "./fourGomokuMatchStore";
import type { StoredRecord, EventReplay } from "./eventRecord";
import type { DecodedMatch } from "../accounts/matchDataContracts";
import { readMatchChunk, matchChunkSize, type ChunkRow } from "./matchChunks";

export type SnapshotMatch = Reversi | FourReversi | Gomoku | FourGomoku;
const reversiStep = reversiReplaySchema.shape.steps.element.shape;
const fourReversiStep = roundReplaySchema.shape.steps.element.shape;
const reversiEvent = z.discriminatedUnion("type", [
  reversiStep.action.options[0].extend({ passedColors: reversiStep.passedColors }),
  reversiStep.action.options[1].extend({ passedColors: reversiStep.passedColors }),
]);
const fourReversiEvent = z.discriminatedUnion("type", [
  fourReversiStep.action.options[0].extend({ passedColors: fourReversiStep.passedColors }),
  fourReversiStep.action.options[1].extend({ passedColors: fourReversiStep.passedColors }),
]);
export function matchEventSchema(game: SnapshotMatch["settings"]["game"]) {
  switch (game) {
    case "reversi":
      return reversiEvent;
    case "four-reversi":
      return fourReversiEvent;
    case "gomoku":
      return gomokuReplaySchema.shape.steps.element.shape.action;
    case "four-gomoku":
      return fourGomokuReplaySchema.shape.steps.element.shape.action;
  }
}
export function encodeSnapshotMatch(record: SnapshotMatch) {
  const { steps, ...initial } = record.replay;
  const replay: EventReplay<SnapshotMatch["replay"]> = {
    ...initial,
    format: "events",
    version: 1,
    eventCount: steps.length,
  };
  if (record.settings.game === "four-gomoku") {
    const omitted = steps.flatMap((step, index) => ("lastMoves" in step.game ? [] : [index]));
    if (omitted.length) replay.omittedLastMoves = omitted;
  }
  const events = steps.map((step) => ({
    ...step.action,
    ...("passedColors" in step ? { passedColors: step.passedColors } : {}),
  }));
  return { record: { ...record, replay }, events };
}
function rebuild<R extends SnapshotMatch, E>(
  record: StoredRecord<R>,
  events: unknown[],
  replay: (initial: R["replay"]["initial"], events: E[]) => unknown[],
  parse: (event: unknown) => E,
) {
  const {
    format: _format,
    version: _version,
    eventCount,
    omittedLastMoves,
    ...initial
  } = record.replay;
  if (events.length !== eventCount) throw new Error("Match event count mismatch");
  const states = replay(initial.initial, events.map(parse));
  const omitted = new Set(omittedLastMoves);
  if ([...omitted].some((index) => index >= eventCount))
    throw new Error("Invalid state field index");
  const steps = states.map((state, index) => {
    const event = events[index];
    if (!event || typeof event !== "object") throw new Error("Invalid match event");
    const { passedColors, ...action } = event as { passedColors?: string[] };
    if (omitted.has(index) && state && typeof state === "object") {
      const { lastMoves: _lastMoves, ...rest } = state as { lastMoves?: unknown };
      state = rest;
    }
    return { action, game: state, ...(passedColors === undefined ? {} : { passedColors }) };
  });
  return { ...record, replay: { ...initial, steps } };
}
export function rebuildSnapshotMatch(match: DecodedMatch, events: unknown[]) {
  switch (match.game) {
    case "reversi":
      return rebuild(match.record, events, reversiDefinition.replay, (event) =>
        reversiEvent.parse(event),
      );
    case "four-reversi":
      return rebuild(match.record, events, fourReversiDefinition.replay, (event) =>
        fourReversiEvent.parse(event),
      );
    case "gomoku":
      return rebuild(match.record, events, gomokuDefinition.replay, (event) =>
        gomokuReplaySchema.shape.steps.element.shape.action.parse(event),
      );
    case "four-gomoku":
      return rebuild(match.record, events, fourGomokuDefinition.replay, (event) =>
        fourGomokuReplaySchema.shape.steps.element.shape.action.parse(event),
      );
    default:
      throw new Error("Expected snapshot game");
  }
}
export async function readSnapshotMatchEvents(db: D1Database, match: DecodedMatch) {
  if (match.game === "shogi" || match.game === "four-shogi") return null;
  const count = match.record.replay.eventCount;
  const rows = await db
    .prepare(`SELECT chunk_index, start_index, event_count, events_json
    FROM match_event_chunks WHERE match_id = ? ORDER BY chunk_index`)
    .bind(match.record.id)
    .all<ChunkRow>();
  if (rows.results.length !== Math.ceil(count / matchChunkSize))
    throw new Error("Missing match replay chunk");
  const schema = matchEventSchema(match.game);
  return rows.results.flatMap((row, index) => {
    if (row.chunk_index !== index) throw new Error("Match replay is not contiguous");
    return readMatchChunk(row, count, (event) => schema.parse(event));
  });
}
