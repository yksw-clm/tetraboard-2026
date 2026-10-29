import type { StudyPositionInput } from "../shared/model";
import type {
  StudyLaneSnapshot,
  StudyRootOptions,
  StudyTaskPolicy,
  StudySplitPlan,
  StudySubtreeTask,
  StudySubtreeResult,
} from "@tetraboard/four-shogi/study-search";
export type SearchCommand =
  | {
      type: "start";
      id: string;
      input: StudyPositionInput;
      options: StudyRootOptions;
      measureTransport?: boolean;
    }
  | { type: "continue"; id: string; depth: number; indices?: number[] }
  | {
      type: "task";
      id: string;
      taskId: number;
      index: number;
      depth: number;
      material: boolean;
      partition?: boolean;
      policy?: StudyTaskPolicy;
    }
  | {
      type: "subtree";
      id: string;
      taskId: number;
      task: StudySubtreeTask | { localPlanId: number; slot: number };
    }
  | { type: "finish"; id: string; taskId: number; planId: number; results: StudySubtreeResult[] }
  | { type: "pause" | "resume" | "cancel"; id: string }
  | { type: "close" };
export type SearchWorkerTiming = {
  restoreMs: number;
  createMs: number;
  activeMs: number;
  cpuMs: number;
  processCpuMs?: number;
  restoreCpuMs?: number;
  createCpuMs?: number;
  transport?: { sendCalls: number; jsonBytes: number; sendMs: number; sizingMs: number };
};
export type SearchMessage =
  | { type: "ready" }
  | {
      type: "progress";
      id: string;
      snapshot: StudyLaneSnapshot;
      memoryBytes: number;
      barrier: boolean;
      taskId?: number;
      reply?:
        | { kind: "split"; plan: StudySplitPlan }
        | { kind: "subtree"; result: StudySubtreeResult };
      timing?: SearchWorkerTiming;
    }
  | { type: "error"; id: string; error: string };
