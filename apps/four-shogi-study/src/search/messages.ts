import type { StudyPositionInput } from "../shared/model";
import type { StudyLaneSnapshot, StudyRootOptions } from "@tetraboard/four-shogi/study-search";
export type SearchCommand =
  | { type: "start"; id: string; input: StudyPositionInput; options: StudyRootOptions }
  | { type: "continue"; id: string; depth: number; indices?: number[] }
  | { type: "pause" | "resume" | "cancel"; id: string }
  | { type: "close" };
export type SearchMessage =
  | { type: "ready" }
  | {
      type: "progress";
      id: string;
      snapshot: StudyLaneSnapshot;
      memoryBytes: number;
      barrier: boolean;
    }
  | { type: "error"; id: string; error: string };
