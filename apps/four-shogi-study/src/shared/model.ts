import type { Side } from "@tetraboard/four-shogi";
import type { AiEvaluation } from "@tetraboard/four-shogi/ai";
import type {
  AnalysisReplayInput,
  AnalysisSetupInput,
  FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";

export type StudySettings = Readonly<{
  mode: "auto" | "analysis";
  thinkTimeMs: number;
  threads: number;
  memoryMb: number;
  analysisTimeMs: number | null;
  seats: Readonly<Record<Side, StudySeat>>;
}>;
export type StudySeat = Readonly<{ controller: "human" | "cpu"; thinkTimeMs: number }>;
export type StudyRecordedAnalysis = Readonly<{
  stateHash: string;
  savedAt: string;
  searchVersion: string;
  evaluationVersion: string;
  engineVersion: string;
  timeBudgetMs: number | null;
  threads: number;
  memoryMb: number;
  elapsedMs: number;
  completedDepth: number;
  evaluation: AiEvaluation;
  candidates: readonly Readonly<{
    evaluation: AiEvaluation;
    events: readonly FourShogiReplayEvent[];
  }>[];
}>;
export type StudyOrigin =
  | Readonly<{ kind: "replay"; replay: AnalysisReplayInput; sourceUrl?: string }>
  | Readonly<{
      kind: "setup";
      setup: AnalysisSetupInput;
      sourceReference?: Readonly<{ studyId: string; nodeId: string }>;
    }>;
export type StudyPositionInput = Readonly<{
  origin: StudyOrigin;
  events: readonly FourShogiReplayEvent[];
}>;
export type StudyNode = Readonly<{
  id: string;
  parentId: string | null;
  event: FourShogiReplayEvent | null;
  comment?: string;
}>;
export type StudyDocument = Readonly<{
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  cpuSide: Side;
  settings: StudySettings;
  playEnabled: boolean;
  origin: StudyOrigin;
  nodes: readonly StudyNode[];
  currentNodeId: string;
  analysisRecords?: Readonly<Record<string, StudyRecordedAnalysis>>;
}>;

export const defaultStudySettings: StudySettings = {
  mode: "auto",
  thinkTimeMs: 5000,
  threads: 4,
  memoryMb: 8192,
  analysisTimeMs: 5000,
  seats: {
    south: { controller: "human", thinkTimeMs: 5000 },
    west: { controller: "cpu", thinkTimeMs: 5000 },
    north: { controller: "cpu", thinkTimeMs: 5000 },
    east: { controller: "cpu", thinkTimeMs: 5000 },
  },
};
