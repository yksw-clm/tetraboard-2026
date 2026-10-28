import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import type { AnalysisPosition, FourShogiReplayEvent } from "@tetraboard/four-shogi/analysis";
import type { AiCandidate, AiEvaluation } from "@tetraboard/four-shogi/ai";
import type { AnalysisSetupInput } from "@tetraboard/four-shogi/analysis";
import type { StudyDocument, StudySettings, StudySearchCoverage } from "./shared/model";
import type { StudyFocusMetadata, StudySearchSnapshot } from "./search/runtime";
export type { StudyFocusMetadata } from "./search/runtime";

export type StudyAnalysisView = {
  coverage?: StudySearchCoverage;
  broadCandidates?: readonly AiCandidate[];
  searchVersion?: string;
  id: string;
  nodeId: string;
  stateHash: string;
  analysisStateHash?: string | null;
  focus?: StudyFocusMetadata | null;
  generation: number;
  status: "running" | "paused" | "completed" | "cancelled" | "error";
  reason: string | null;
  elapsedMs: number;
  completedDepth: number;
  work: number;
  nodes: number;
  memoryBytes: number;
  performance?: StudySearchSnapshot["performance"];
  candidates: readonly AiCandidate[];
  recommendedAction: FourShogiAction | null;
  analysisRecommendedAction?: FourShogiAction | null;
  evaluation: AiEvaluation | null;
  saved?: {
    savedAt: string;
    searchVersion: string;
    evaluationVersion: string;
    engineVersion: string;
    timeBudgetMs: number | null;
    threads: number;
    memoryMb: number;
  };
};
export type StudyLiveView = {
  sourceUrl: string;
  instanceId: string;
  roundId: string;
  eventCount: number;
  latestNodeId: string;
  follow: boolean;
  status: "connecting" | "syncing" | "live" | "reconnecting" | "finished" | "closed" | "error";
  message: string | null;
  nextStudyId?: string;
};

export type StudyHistoryEntry = {
  id: string;
  parentId: string | null;
  label: string;
  moveNumber: number;
  evaluation: AiEvaluation;
};

export type StudySnapshot = {
  warnings?: readonly string[];
  study: StudyDocument;
  position: AnalysisPosition;
  legalActions: readonly FourShogiAction[];
  forbiddenActions: readonly FourShogiAction[];
  staticEvaluation: AiEvaluation;
  history: StudyHistoryEntry[];
  analysis: StudyAnalysisView | null;
  live?: StudyLiveView;
};

export type StudyConfig = {
  logicalCpus: number;
  totalMemoryMb: number;
  defaultThreads: number;
  defaultMemoryMb: number;
  dataDirectory: string;
};

export type StudyListEntry = {
  id: string;
  title: string;
  updatedAt: string;
  cpuSide: Side;
  cpuSides?: readonly Side[];
};

export type StudyCommand = { expectedRevision: number } & (
  | { type: "action"; action: FourShogiAction }
  | { type: "event"; event: FourShogiReplayEvent }
  | { type: "select"; nodeId: string }
  | { type: "settings"; settings: Partial<StudySettings>; title?: string }
  | { type: "setup"; setup: AnalysisSetupInput; title?: string }
  | { type: "resumePlay" }
  | { type: "pausePlay" }
  | { type: "comment"; nodeId: string; comment: string }
  | {
      type: "variation";
      analysisId: string;
      stateHash: string;
      candidateIndex: number;
      plies: number;
      lineSignature: string;
    }
  | { type: "liveFollow"; enabled: boolean }
  | { type: "liveReconnect" }
  | { type: "liveDisconnect" }
);

export type StudyAnalysisCommand = { expectedRevision: number } & (
  | { command: "start" }
  | { command: "pause" }
  | { command: "resume" }
  | { command: "adopt"; analysisId: string; stateHash: string; action?: FourShogiAction }
);

export type StudyServerEvent =
  | { type: "snapshot"; snapshot: StudySnapshot }
  | { type: "analysis"; studyId: string; analysis: StudyAnalysisView }
  | { type: "error"; studyId: string | null; message: string };
