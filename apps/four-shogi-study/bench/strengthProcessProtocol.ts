import type { Player } from "../../../packages/four-shogi/bench/baseline";
import type { RecordedGame, StrengthJob, StrengthOptions } from "./strength";

export type StrengthProcessConfig = Readonly<{
  options: StrengthOptions;
  contractHash: string;
  runnerVersion: string;
  code: unknown;
  opponentId: string;
  opponentMetadata: Player["metadata"];
}>;

export type StrengthParentCommand =
  | Readonly<{
      type: "init";
      runId: string;
      generation: string;
      lane: number;
      config: StrengthProcessConfig;
    }>
  | Readonly<{ type: "run"; runId: string; generation: string; job: StrengthJob }>
  | Readonly<{ type: "stop" | "close"; runId: string; generation: string }>;

type Envelope = Readonly<{ runId: string; generation: string; lane: number; contractHash: string }>;
export type StrengthParentMessage = Envelope &
  (
    | Readonly<{
        type: "ready";
        code: unknown;
        opponentId: string;
        opponentMetadata: Player["metadata"];
      }>
    | Readonly<{ type: "result"; jobId: string; game: RecordedGame }>
    | Readonly<{ type: "error"; jobId: string | null; message: string }>
    | Readonly<{ type: "closed" }>
  );

export type StrengthParentFailure = Readonly<{
  lane: number;
  jobId: string | null;
  message: string;
  kind: "worker_exit" | "protocol" | "result_conflict" | "cleanup";
  resolved: boolean;
}>;
