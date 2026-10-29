import { cpus, totalmem, release } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStudySearchRuntime } from "../src/search/runtime";
import { parallelTrial } from "./parallelSearch";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudyPositionInput } from "../src/shared/model";
import {
  applyAction,
  getActiveSides,
  getLegalActions,
  type FourShogiAction,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import { chooseCpuActionWithDiagnostics } from "../../../packages/four-shogi/src/cpu";
import {
  tacticalCases,
  acceptsTactic,
  tacticalFixtureVersion,
} from "../../../packages/four-shogi/bench/tactics";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { positionForSide } from "../../../packages/four-shogi/src/board";
import {
  studySearchVersion,
  studySearchStrategies,
  type StudySearchStrategy,
  type StudyCandidate,
  type StudyProfile,
} from "@tetraboard/four-shogi/study-search";
import { sides } from "../../../packages/four-shogi/src/types";
const args = new Map(
  Bun.argv.slice(2).map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`invalid argument ${arg}`);
    return [match[1], match[2]];
  }),
);
const kind = args.get("kind") ?? "performance";
const timeBudgetMs = Number(args.get("time-ms") ?? 5000);
const maxWork = Number(args.get("max-work") ?? 20000000);
if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new Error("max-workは正の整数です");
const threads = (args.get("threads") ?? (kind === "performance" ? "1,2,4,8" : "4"))
  .split(",")
  .map(Number);
const productionDir = args.get("production-dir");
const profiles = (args.get("profiles") ?? "study").split(",");
const strategies = (args.get("strategies") ?? "adaptive").split(",");
if (
  !strategies.length ||
  strategies.some((entry) => !studySearchStrategies.includes(entry as StudySearchStrategy))
)
  throw new Error("strategies must be legacy, adaptive and/or dual");
if (!profiles.length || profiles.some((profile) => !["study", "baseline"].includes(profile)))
  throw new Error("profiles must be study and/or baseline");
const taskPartition = args.get("task-partition") ?? "root";
if (taskPartition !== "root" && taskPartition !== "replies")
  throw new Error("task-partitionはrootまたはrepliesです");
const criticalOnly = args.get("critical-only") === "true";
if (args.has("critical-only") && !["true", "false"].includes(args.get("critical-only")!))
  throw new Error("critical-only must be true or false");
const sourceFingerprint = () => ({
  engine: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
  runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")),
  measurement: [
    "apps/four-shogi-study/bench/search.ts",
    "apps/four-shogi-study/bench/parallelSearch.ts",
    "apps/four-shogi-study/bench/searchEfficiency.ts",
    "apps/four-shogi-study/bench/parallelTelemetry.ts",
    "packages/four-shogi/bench/tactics.ts",
    "packages/four-shogi/bench/positionFixture.ts",
  ].map((path) => ({
    path,
    sha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(resolve(repoRoot, path)))
      .digest("hex"),
  })),
});
const code = {
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  source: sourceFingerprint(),
};
const startedAt = new Date().toISOString();
const initial: StudyPositionInput = {
  origin: {
    kind: "replay",
    replay: {
      schemaVersion: 1,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: true,
      },
      events: [],
    },
  },
  events: [],
};
function fromState(state: FourShogiState): StudyPositionInput {
  return {
    origin: {
      kind: "setup",
      setup: {
        schemaVersion: 1,
        board: state.board.map((row) =>
          row.map((piece) =>
            piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
          ),
        ),
        hands: state.hands,
        turn: state.turn!,
        threePlayerAttackProhibited: state.threePlayerAttackProhibited,
        eliminations: state.eliminations.map((entry) => ({
          side: entry.side,
          rank: entry.rank!,
          group: entry.group,
        })),
      },
    },
    events: [],
  };
}
async function production() {
  if (!productionDir) return [];
  const rows = (await Bun.file(`${productionDir}/tactics.jsonl`).text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          index: number;
          safeCount: number;
          actual: { mateReplies: unknown[] };
        },
    )
    .filter((row) => row.safeCount > 0 && row.actual.mateReplies.length);
  const cases: { id: string; input: StudyPositionInput }[] = [];
  for (const row of rows) {
    const source = await Bun.file(`${productionDir}/${row.id}.json`).json();
    if (source.match.replay.initial.mode !== "singles") continue;
    cases.push({
      id: `${row.id}:${row.index}`,
      input: {
        origin: {
          kind: "replay",
          replay: {
            schemaVersion: 1,
            rulesVersion: 1,
            ruleProfileId: "tetraboard-four-shogi-singles-v1",
            initial: {
              ...source.match.replay.initial,
              players: { south: "s", west: "w", north: "n", east: "e" },
            },
            events: source.events.slice(0, row.index),
          },
        },
        events: [],
      },
    });
  }
  return cases;
}
function safe(state: FourShogiState, action: FourShogiAction | null) {
  if (!action || state.status !== "playing") return false;
  const root = state.turn;
  const applied = applyAction(state, root, action);
  if (!applied.ok || !getActiveSides(applied.state).includes(root)) return false;
  if (applied.state.status === "finished") return true;
  return getLegalActions(applied.state).every((reply) => {
    const next = applyAction(applied.state, applied.state.turn!, reply);
    return next.ok && getActiveSides(next.state).includes(root);
  });
}
const results: unknown[] = [];
const skipped: unknown[] = [];
for (const count of threads)
  for (const strategy of strategies)
    for (const profile of profiles) {
      const runtime = createStudySearchRuntime({
        threads: count,
        taskPartition,
        cpuProfileDirectory: args.get("cpu-profile-dir"),
      });
      async function analyze(input: StudyPositionInput) {
        const result = await parallelTrial(
          runtime,
          input,
          {
            timeBudgetMs,
            profile: profile as StudyProfile,
            strategy: strategy as StudySearchStrategy,
          },
          maxWork,
        );
        const value = result.snapshot;
        return {
          ...value,
          wallMs: result.responseMs,
          nodesPerSecond: value.nodes / (value.elapsedMs / 1000),
          limitReason: result.limitReason,
        };
      }
      try {
        if (kind === "performance" || kind === "production" || kind === "efficiency") {
          const examples = await production();
          const cases: { id: string; input: StudyPositionInput }[] = args.has("inputs")
            ? await Bun.file(args.get("inputs")!).json()
            : kind === "production"
              ? examples
              : [
                  { id: "initial-on", input: initial },
                  ...(examples.length ? [{ ...examples[0], id: "production-middle" }] : []),
                ];
          if (!cases.length)
            throw new Error("production-dir is required and must contain singles regressions");
          for (const entry of cases) {
            const position = await restoreStudyPosition(entry.input);
            const baseline = chooseCpuActionWithDiagnostics(position.state);
            const analysis = await analyze(entry.input);
            const candidate = analysis.candidates[0] as Partial<StudyCandidate> | undefined;
            const result = {
              id: entry.id,
              stateHash: position.stateHash,
              strategy,
              threads: count,
              profile,
              baseline: {
                action: baseline.action,
                safeImmediateReply: safe(position.state, baseline.action),
                work: baseline.stats.work,
              },
              search: {
                action: analysis.recommendedAction,
                safeImmediateReply: safe(position.state, analysis.recommendedAction),
                completedDepth: analysis.completedDepth,
                elapsedMs: analysis.elapsedMs,
                wallMs: analysis.wallMs,
                nodes: analysis.nodes,
                work: analysis.work,
                memoryBytes: analysis.memoryBytes,
                nodesPerSecond: analysis.nodesPerSecond,
                reason: analysis.reason,
                diagnostics: analysis.diagnostics,
                performance: analysis.performance,
                coverage: analysis.coverage,
                broadCandidates: analysis.broadCandidates,
                evaluation: analysis.evaluation,
                principalVariation: analysis.candidates[0]?.line ?? [],
                material: candidate?.study?.material ?? null,
                magicEvidence: candidate?.study?.magicEvidence ?? null,
              },
            };
            results.push(result);
            console.log(JSON.stringify(result));
          }
        } else if (kind === "tactics") {
          const cases = tacticalCases().filter((entry) => entry.state.mode === "singles");
          for (const restricted of [false, true])
            for (const [offset, orientation] of sides.entries()) {
              const state = fixture({
                threePlayerAttackProhibited: restricted,
                kings: { south: "A8", east: "C8" },
                pieces: [
                  { side: "south", kind: "rook", at: "E3" },
                  { side: "west", kind: "gold", at: "C3" },
                  { side: "north", kind: "silver", at: "B4" },
                ],
              });
              const board = state.board.map((row) =>
                row.map(() => null),
              ) as FourShogiState["board"][number][number][][];
              for (let y = 0; y < 9; y++)
                for (let x = 0; x < 9; x++) {
                  const piece = state.board[y][x];
                  const to = positionForSide({ x, y }, orientation);
                  board[to.y][to.x] = piece
                    ? { ...piece, side: sides[(sides.indexOf(piece.side) + offset) % 4] }
                    : null;
                }
              cases.push({
                id: `valid-magic-${restricted}-${orientation}`,
                family: "valid-magic",
                split: "validation",
                criterion: "magic",
                critical: true,
                proof: "西の金を取り東王へ王手し、北銀の取り返しより先に南へ戻る",
                state: { ...state, status: "playing", result: null, board, turn: orientation },
              });
            }
          for (const entry of cases.filter((entry) => !criticalOnly || entry.critical)) {
            const input = fromState(entry.state);
            let stateHash: string;
            try {
              stateHash = (await restoreStudyPosition(input)).stateHash;
            } catch (error) {
              if (entry.critical)
                throw new Error(`重要戦術局面を復元できません: ${entry.id}: ${String(error)}`);
              skipped.push({ id: entry.id, reason: String(error) });
              continue;
            }
            const analysis = await analyze(input);
            const action = analysis.recommendedAction;
            const best = analysis.candidates[0] as StudyCandidate | undefined;
            const accepted =
              analysis.status === "completed" &&
              ["deadline", "max_depth", "sole_win", "terminal"].includes(analysis.reason ?? "") &&
              analysis.limitReason === null &&
              (entry.family === "valid-magic"
                ? Boolean(
                    analysis.candidates[0]?.line[0]?.captured?.kind === "gold" &&
                    best?.study.magicEvidence?.status === "line_confirmed" &&
                    best.study.material.lineDelta >= 500,
                  )
                : acceptsTactic(entry, action));
            const result = {
              id: entry.id,
              input,
              stateHash,
              strategy,
              threads: count,
              profile,
              critical: entry.critical,
              accepted,
              status: analysis.status,
              reason: analysis.reason,
              limitReason: analysis.limitReason,
              safeImmediateReply: safe(entry.state, action),
              action,
              completedDepth: analysis.completedDepth,
              work: analysis.work,
              elapsedMs: analysis.elapsedMs,
              evaluation: analysis.evaluation,
              principalVariation: best?.line ?? [],
              coverage: analysis.coverage,
              performance: analysis.performance,
              ...(accepted ? {} : { candidates: analysis.candidates }),
            };
            results.push(result);
            console.log(JSON.stringify(result));
          }
        } else throw new Error("kind must be performance, efficiency, production or tactics");
      } finally {
        await runtime.close();
      }
    }
const report = {
  schemaVersion: 2,
  startedAt,
  searchVersion: studySearchVersion,
  fixtureVersion: tacticalFixtureVersion,
  code: {
    ...code,
    sourceUnchanged:
      code.commit === git("rev-parse", "HEAD") &&
      JSON.stringify(code.source) === JSON.stringify(sourceFingerprint()),
  },
  kind,
  claim: "limited engineering/tactical measurement; not strength certification",
  settings: { timeBudgetMs, maxWork, threads, profiles, strategies, criticalOnly, taskPartition },
  inputsSha256: args.has("inputs")
    ? new Bun.CryptoHasher("sha256")
        .update(await Bun.file(args.get("inputs")!).arrayBuffer())
        .digest("hex")
    : null,
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  results,
  skipped,
};
if (args.has("output"))
  await Bun.write(args.get("output")!, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ complete: true, count: results.length, skipped: skipped.length }));
