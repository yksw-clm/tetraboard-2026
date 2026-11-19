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
import { rebuildSnapshotMatch as rebuild, encodeSnapshotMatch } from "@tetraboard/context-record";
export { encodeSnapshotMatch };
import type { DecodedMatch } from "./matchDataContracts";

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
export function rebuildSnapshotMatch(match: DecodedMatch, events: unknown[]) {
  switch (match.game) {
    case "reversi":
      return rebuild<Reversi, Parameters<typeof reversiDefinition.replay>[1][number]>(
        match.record,
        events,
        reversiDefinition.replay,
        (event) => reversiEvent.parse(event),
      );
    case "four-reversi":
      return rebuild<FourReversi, Parameters<typeof fourReversiDefinition.replay>[1][number]>(
        match.record,
        events,
        fourReversiDefinition.replay,
        (event) => fourReversiEvent.parse(event),
      );
    case "gomoku":
      return rebuild<Gomoku, Parameters<typeof gomokuDefinition.replay>[1][number]>(
        match.record,
        events,
        gomokuDefinition.replay,
        (event) => gomokuReplaySchema.shape.steps.element.shape.action.parse(event),
      );
    case "four-gomoku":
      return rebuild<FourGomoku, Parameters<typeof fourGomokuDefinition.replay>[1][number]>(
        match.record,
        events,
        fourGomokuDefinition.replay,
        (event) => fourGomokuReplaySchema.shape.steps.element.shape.action.parse(event),
      );
    default:
      throw new Error("Expected snapshot game");
  }
}
