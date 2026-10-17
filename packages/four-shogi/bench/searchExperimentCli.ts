import { cpus, release, totalmem } from "node:os";
import { sides } from "../src/index";
import { analyzePosition } from "../src/ai";
import { loadPlayer, git, repoRoot, sourceIdentity } from "./baseline";
import { hashJson, seatLineup, summarizeSingles, type SinglesSample } from "./singlesMeasurement";
import { summarizeTimes } from "./measurement";
import {
  experimentOptions,
  experimentStarts,
  experimentVariants,
  measureSearchTactics,
  measureSearchPerformance,
  playAnalysisSingles,
  type VariantName,
  type PositionDecision,
} from "./searchExperiment";

const args = new Map<string, string>();
const allowed = new Set([
  "kind",
  "variants",
  "budget",
  "amount",
  "seed",
  "series",
  "max-plies",
  "repeats",
  "output",
]);
for (const arg of Bun.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !allowed.has(match[1]) || args.has(match[1]))
    throw new Error(`不正・重複した引数: ${arg}`);
  args.set(match[1], match[2]);
}
function integer(name: string, fallback: number) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}は正の整数です`);
  return value;
}
const kind = args.get("kind") ?? "factors";
if (!["factors", "performance", "matches"].includes(kind))
  throw new Error("kindはfactors/performance/matchesです");
const budget = args.get("budget") ?? "work";
if (budget !== "work" && budget !== "time") throw new Error("budgetはwork/timeです");
const names = (
  args.get("variants") ??
  (kind === "factors"
    ? "base,cached,previous,width3,root6,depth6,extensions0,extensions1,kingRing50,mcts"
    : "base,cached,tuned,mcts")
).split(",");
if (
  new Set(names).size !== names.length ||
  names.some((name) => !Object.hasOwn(experimentVariants, name))
)
  throw new Error("未知・重複した比較方式です");
const variants = names as VariantName[];
const amount = integer("amount", budget === "work" ? 2048 : 100);
const codeVersion = git("rev-parse", "HEAD");
const metadata = {
  schemaVersion: 1,
  measurementKind: "bounded-tuning-experiment; not-final-strength-evaluation",
  runnerCommit: codeVersion,
  runnerDirty: git("status", "--porcelain").length > 0,
  runnerSource: sourceIdentity(`${repoRoot}/packages/four-shogi/bench`),
  ruleEngineSource: sourceIdentity(`${repoRoot}/packages/four-shogi/src`),
  args: Object.fromEntries(args),
  environment: {
    bun: Bun.version,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model ?? null,
    memoryBytes: totalmem(),
    rssUnit: "bytes",
    timeUnit: "milliseconds",
  },
  budgetInterpretation:
    budget === "time"
      ? "same wall-clock limit; work cap 100000000 and MCTS simulations 1000000 are safeguards, report actual stop reasons"
      : "same reproducible work cap; report actual times separately",
  heldOut:
    "original validation tactics and seeds>=100000 excluded; rotations of a family are not independent evidence",
};
async function output(result: unknown) {
  const data = `${JSON.stringify(result, null, 2)}\n`;
  if (args.has("output")) await Bun.write(args.get("output")!, data);
  else process.stdout.write(data);
}
if (kind === "factors")
  await output({
    metadata,
    complete: true,
    ...(await measureSearchTactics(variants, budget, amount, codeVersion)),
  });
else {
  const starts = await experimentStarts(
    [false, true],
    integer("series", 1),
    integer("seed", 18800),
  );
  if (kind === "performance")
    await output({
      metadata,
      complete: true,
      ...(await measureSearchPerformance(
        variants,
        starts,
        budget,
        amount,
        integer("repeats", 2),
        codeVersion,
      )),
    });
  else {
    const frozen = await loadPlayer("frozen");
    try {
      const groups: {
        name: VariantName;
        restricted: boolean;
        samples: SinglesSample[];
        diagnostics: unknown[];
        summary: unknown;
      }[] = variants.flatMap((name) =>
        [false, true].map((restricted) => ({
          name,
          restricted,
          samples: [],
          diagnostics: [],
          summary: null,
        })),
      );
      const total = variants.length * starts.length * 4;
      let completed = 0;
      const maxPlies = integer("max-plies", 96);
      const report = () => ({
        metadata,
        reference: { id: frozen.id, ...frozen.metadata },
        complete: completed === total,
        completed,
        total,
        maxPlies,
        corpusHash: hashJson(starts.map((entry) => entry.start)),
        groups,
        drawPolicy: "actions-only; no clocks, draw proposals or disconnects",
      });
      for (const group of groups) {
        const candidateId = `analysis-${group.name}`;
        const options = experimentOptions(group.name, budget, amount, codeVersion);
        const selectors = new Map<
          string,
          (position: Parameters<typeof analyzePosition>[0]) => Promise<PositionDecision>
        >([
          [
            candidateId,
            async (position) => {
              const result = await analyzePosition(position, options);
              return {
                action: result.recommendedAction,
                stats: {
                  work: result.diagnostics.work,
                  completedDepth: result.diagnostics.completedDepth,
                  cutoff: result.status === "limited",
                },
                details: {
                  versions: result.versions,
                  settings: result.settings,
                  diagnostics: result.diagnostics,
                  inputHash: result.input.stateHash,
                },
              };
            },
          ],
          [
            frozen.id,
            async (position) => ({
              ...frozen.selector(position.state),
              details: { fixedCommit: frozen.metadata.commit },
            }),
          ],
        ]);
        for (const start of starts.filter(
          (entry) => entry.position.state.threePlayerAttackProhibited === group.restricted,
        ))
          for (const seat of sides) {
            const { sample, diagnostics } = await playAnalysisSingles(
              start,
              seat,
              seatLineup(seat, candidateId, [frozen.id, frozen.id, frozen.id]),
              selectors,
              maxPlies,
            );
            group.samples.push(sample);
            group.diagnostics.push(diagnostics);
            completed++;
            const summary = summarizeSingles(group.samples);
            const decisions = group.samples.flatMap((entry) =>
              entry.decisions.filter((decision) => decision.playerId === candidateId),
            );
            group.summary = {
              ...summary,
              tiedFirstRate: summary.tiedFirst / summary.games,
              candidateTimes: summarizeTimes(decisions.map((entry) => entry.elapsedMs)),
              work: decisions.reduce((sum, entry) => sum + (entry.stats?.work ?? 0), 0),
            };
            process.stderr.write(
              `${completed}/${total} ${group.name} restricted=${group.restricted} seat=${seat} ${sample.termination}\n`,
            );
            if (args.has("output")) await output(report());
          }
      }
      await output(report());
    } finally {
      frozen.dispose();
    }
  }
}
