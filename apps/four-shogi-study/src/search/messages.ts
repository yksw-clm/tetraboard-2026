import type { StudyPositionInput } from "../shared/model";
import type {
  StudyLaneSnapshot,
  StudyRootOptions,
  StudyTaskPolicy,
} from "@tetraboard/four-shogi/study-search";
export type SearchCommand =
  | { type: "start"; id: string; input: StudyPositionInput; options: StudyRootOptions }
  | { type: "continue"; id: string; depth: number; indices?: number[] }
  | {
      type: "task";
      id: string;
      taskId: number;
      index: number;
      depth: number;
      material: boolean;
      policy?: StudyTaskPolicy;
    }
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
      taskId?: number;
    }
  | { type: "error"; id: string; error: string };
