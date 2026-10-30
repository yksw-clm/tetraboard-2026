import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getActiveSides, sides, type Side } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  restoreAnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import {
  createStudySearchRuntime,
  type StudySearchSnapshot,
  type StudySearchRuntime,
  type StudySearchOptions,
} from "../src/search/runtime";
import { createPvFocusRuntime } from "../src/search/focusRuntime";
import { createPonderFocusRuntime } from "../src/search/ponderRuntime";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudyPositionInput } from "../src/shared/model";
import { guardBenchIdentity } from "./lethalGuardBench";
import { validateGuardCandidate } from "./lethalGuardValidation";
import { studyTacticalCases, acceptsStudyTactic } from "./studyTactics";
import { tacticInput } from "./tacticsDiagnostics";
import { loadPlayer } from "../../../packages/four-shogi/bench/baseline";
import {
  hashJson,
  resultLabels,
  seatLineup,
} from "../../../packages/four-shogi/bench/singlesMeasurement";
import {
  createStrengthOpening,
  forcedLegalChoice,
  type RecordedGame,
  type StrengthJob,
  type StrengthChoice,
} from "./strength";
import {
  createStrengthJournal,
  readStrengthJournal,
  replayStrengthJournal,
  verifyStrengthGame,
} from "./strengthJournal";

export type FocusWay = "BASE" | "PV" | "PONDER" | "COMBINED";
const modes: FocusWay[] = ["BASE", "PV", "PONDER", "COMBINED"];
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const append = (file: string, value: unknown) => appendFileSync(file, JSON.stringify(value) + "\n");
const absoluteDeadline = Date.parse("2026-10-31T01:00:00+00:00");
export function focusTrialRuntime(way: FocusWay) {
  const config = {
    threads: 4,
    memoryMb: 4096,
    taskPartition: "root" as const,
    measureStages: true,
  };
  return way === "BASE"
    ? createStudySearchRuntime(config)
    : way === "PV"
      ? createPvFocusRuntime(config)
      : createPonderFocusRuntime(config, {
          mode: way === "PONDER" ? "ponder" : "combined",
          ponderMs: 1000,
          ttlMs: 30000,
        });
}
export async function focusTrial(
  runtime: StudySearchRuntime,
  input: StudyPositionInput,
  options: StudySearchOptions,
) {
  if (Date.now() >= absoluteDeadline - 2000) throw Error("absolute deadline");
  const started = performance.now(),
    parentCpu = process.cpuUsage();
  let firstCompletedMs: number | null = null,
    firstForegroundMs: number | null = null;
  let last: StudySearchSnapshot | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const snapshot = await new Promise<StudySearchSnapshot>((resolve, reject) => {
    watchdog = setTimeout(
      () => {
        reject(Error("focus trial missing final notification"));
      },
      (options.timeBudgetMs ?? 5000) + 1500,
    );
    void runtime
      .start(input, options, (s) => {
        last = s;
        if (s.completedDepth > 0 && firstCompletedMs === null)
          firstCompletedMs = performance.now() - started;
        if (s.recommendedAction && firstForegroundMs === null)
          firstForegroundMs = performance.now() - started;
        if (s.status === "error" || s.status === "cancelled") reject(Error(s.reason ?? s.status));
        else if (s.status === "completed") resolve(s);
      })
      .catch(reject);
  }).finally(() => clearTimeout(watchdog));
  const responseMs = performance.now() - started,
    cpu = process.cpuUsage(parentCpu);
  if (!last || snapshot.status !== "completed") throw Error("missing completed snapshot");
  const position = await restoreStudyPosition(input);
  if (
    snapshot.stateHash !== position.stateHash ||
    snapshot.focus?.sourceStateHash !== position.stateHash ||
    snapshot.focus?.side !== options.focusSide
  )
    throw Error("old source/focus");
  let target = position;
  for (const step of snapshot.focus?.prefix ?? [])
    target = await advanceAnalysisPosition(target, {
      type: "action",
      side: step.side,
      action: step.action,
    });
  if (snapshot.focus?.status === "ready") {
    if (target.stateHash !== snapshot.analysisStateHash || target.state.turn !== options.focusSide)
      throw Error("target state mismatch");
    for (const c of [...snapshot.candidates, ...(snapshot.broadCandidates ?? [])])
      await validateGuardCandidate(target, c);
    if (snapshot.focus.conditional && snapshot.recommendedAction !== null)
      throw Error("future move published as current");
    if (
      !snapshot.focus.conditional &&
      snapshot.recommendedAction &&
      !getAnalysisLegalActions(position).some(
        (a) => hashJson(a) === hashJson(snapshot.recommendedAction),
      )
    )
      throw Error("illegal current recommendation");
  }
  return {
    snapshot,
    responseMs,
    firstCompletedMs,
    firstForegroundMs,
    parentCpuMs: (cpu.user + cpu.system) / 1000,
    workerCpuMs:
      snapshot.continuation?.workerCpuMs ??
      (snapshot.timing?.workers ?? []).reduce((n, w) => n + (w?.cpuMs ?? 0), 0),
    workerActiveMs:
      snapshot.continuation?.workerActiveMs ??
      (snapshot.timing?.workers ?? []).reduce((n, w) => n + (w?.activeMs ?? 0), 0),
    withinBudget: responseMs <= (options.timeBudgetMs ?? Infinity),
    targetHash: target.stateHash,
  };
}

export async function qualityFocus(root: string) {
  const output = join(root, "validation/focus-critical-v2.jsonl");
  if (existsSync(output)) throw Error("preserved results");
  const source = guardBenchIdentity();
  const cases = studyTacticalCases().filter((t) => t.critical);
  if (cases.length !== 40) throw Error("critical fixture set changed");
  let allPass = true;
  for (const way of modes) {
    const runtime = focusTrialRuntime(way);
    try {
      for (const t of cases) {
        const input = tacticInput(t.state),
          p = await restoreStudyPosition(input);
        const r = await focusTrial(runtime, input, {
          strategy: "dual-continuations",
          broadDepth: 3,
          timeBudgetMs: 1000,
          focusSide: p.state.turn!,
          sessionKey: "critical/" + t.id,
        });
        const pass =
          r.snapshot.completedDepth > 0 &&
          !!r.snapshot.recommendedAction &&
          acceptsStudyTactic(t, r.snapshot) &&
          r.withinBudget &&
          r.snapshot.continuation?.pauseAcknowledged !== false;
        allPass &&= pass;
        append(output, { source, way, id: t.id, pass, ...r });
        await runtime.releaseFocus?.();
        console.log(
          JSON.stringify({ phase: "critical", way, id: t.id, pass, responseMs: r.responseMs }),
        );
      }
    } finally {
      await runtime.close();
    }
  }
  save(join(root, "validation/focus-critical-v2-complete.json"), {
    source,
    cases: 40,
    ways: modes,
    allPass,
    sourceUnchanged: hashJson(source) === hashJson(guardBenchIdentity()),
  });
  if (!allPass) throw Error("critical adoption gate failed");
}

export async function compareFocus(root: string) {
  const output = join(root, "performance/focus-time.jsonl");
  if (existsSync(output)) throw Error("preserved results");
  const source = guardBenchIdentity();
  const cases = ["results.jsonl", "extended-results.jsonl"]
    .flatMap((f) =>
      readFileSync(join(root, "baseline", f), "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x)),
    )
    .filter((x) => x.repeat === 0);
  for (const [index, c] of cases.entries())
    for (const way of [...modes.slice(index % 4), ...modes.slice(0, index % 4)]) {
      const input = read(join(root, "inputs", c.id + ".json"));
      const offset = input.replay.eventOffset ?? input.replay.events.length;
      const actualEvents = input.replay.events.slice(offset);
      const replay = {
          ...structuredClone(input.replay),
          events: structuredClone(input.replay.events.slice(0, offset)),
        },
        runtime = focusTrialRuntime(way),
        scope = "perf/" + c.id;
      let p = await restoreAnalysisPosition(replay),
        transitions = 0;
      const forecasts = [];
      try {
        while (
          p.state.turn !== input.focus &&
          transitions < 12 &&
          p.state.status === "playing" &&
          getActiveSides(p.state).includes(input.focus)
        ) {
          const sourceInput: StudyPositionInput = {
            origin: { kind: "replay", replay: structuredClone(replay) },
            events: [],
          };
          const r = await focusTrial(runtime, sourceInput, {
            strategy: "dual-continuations",
            broadDepth: 3,
            timeBudgetMs: 1000,
            focusSide: input.focus,
            sessionKey: scope,
          });
          const actual = actualEvents[transitions];
          if (!actual) throw Error("missing actual development event");
          const event = actual.event ?? actual;
          forecasts.push({
            ...r,
            actualEvent: event,
            firstMatch:
              hashJson(r.snapshot.focus?.prefix[0]?.action ?? null) === hashJson(event.action),
          });
          await runtime.holdFocus?.(r.snapshot.id);
          if (way === "BASE") await runtime.cancel(r.snapshot.id);
          p = await advanceAnalysisPosition(p, event);
          replay.events.push({ index: replay.events.length, event });
          replay.eventOffset = replay.events.length;
          transitions++;
        }
        if (p.state.turn !== input.focus) {
          append(output, { source, id: c.id, way, unreached: true, forecasts });
          continue;
        }
        const r = await focusTrial(
          runtime,
          { origin: { kind: "replay", replay }, events: [] },
          {
            strategy: "dual-continuations",
            broadDepth: 3,
            timeBudgetMs: 5000,
            focusSide: input.focus,
            sessionKey: scope,
          },
        );
        append(output, { source, id: c.id, way, forecasts, transitions, ...r });
        console.log(
          JSON.stringify({
            phase: "time",
            id: c.id,
            way,
            depth: r.snapshot.completedDepth,
            first: r.firstForegroundMs,
            hit: r.snapshot.continuation?.sessionHit,
          }),
        );
      } finally {
        await runtime.close();
      }
    }
  save(join(root, "performance/focus-time-complete.json"), {
    source,
    complete: true,
    sourceUnchanged: hashJson(source) === hashJson(guardBenchIdentity()),
  });
}

export async function playFocusGame(
  root: string,
  way: FocusWay,
  seed: number,
  seat: Side,
  phase: string,
) {
  const directory = join(root, "strength", phase);
  mkdirSync(directory, { recursive: true });
  const source = guardBenchIdentity(),
    id = hashJson({ way, seed, seat, phase, source });
  const output = join(directory, id + ".json"),
    metrics = join(directory, id + "-search.jsonl");
  if (existsSync(output) || existsSync(metrics))
    throw Error("game results preserved, do not overwrite");
  const job: StrengthJob = {
    id,
    seed,
    restricted: true,
    seat,
    profile: "study",
    searchStrategy: "dual-continuations",
  };
  const opponent = await loadPlayer("frozen"),
    opening = await createStrengthOpening(seed, true),
    runtime = focusTrialRuntime(way);
  const lineup = seatLineup(seat, way, Array(3).fill(opponent.id)),
    journal = createStrengthJournal(directory),
    journalFile = join(directory, id + ".jsonl");
  const started = performance.now(),
    parentCpu = process.cpuUsage();
  let p = opening.position,
    stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const replay = { ...structuredClone(opening.replay), events: [...opening.replay.events] };
  journal({
    type: "start",
    job,
    lane: 0,
    replay: structuredClone(replay),
    lineup,
    stateHash: p.stateHash,
  });
  let ownMoves = 0,
    backgroundWindows = 0;
  try {
    for (let ply = 0; ply < 256 && p.state.status === "playing" && !stopped; ply++) {
      if (Date.now() >= absoluteDeadline - 7000) {
        stopped = true;
        break;
      }
      const side = p.state.turn!,
        before = performance.now(),
        beforeHash = p.stateHash;
      const legal = getAnalysisLegalActions(p);
      let choice: StrengthChoice | null = null,
        action = null,
        stats = null;
      let forecast: StudySearchSnapshot | null = null;
      const active = getActiveSides(p.state).includes(seat);
      if (active && (side !== seat || legal.length !== 1)) {
        const r = await focusTrial(
          runtime,
          { origin: { kind: "replay", replay: structuredClone(replay) }, events: [] },
          {
            strategy: "dual-continuations",
            broadDepth: 3,
            timeBudgetMs: side === seat ? 5000 : 1000,
            focusSide: seat,
            sessionKey: id,
          },
        );
        append(metrics, { ply, side, beforeHash, own: side === seat, ...r });
        if (!r.withinBudget || r.snapshot.continuation?.pauseAcknowledged === false)
          throw Error("deadline/pause adoption gate failed");
        if (side === seat) {
          if (r.snapshot.completedDepth < 1 || !r.snapshot.recommendedAction)
            throw Error("own-turn has no completed legal result");
          ownMoves++;
          choice = {
            action: r.snapshot.recommendedAction,
            work: r.snapshot.work,
            depth: r.snapshot.completedDepth,
            cutoff: r.snapshot.reason === "deadline",
            elapsedMs: r.responseMs,
            reason: r.snapshot.reason ?? "unknown",
            safetyComplete: r.snapshot.diagnostics.safetyComplete,
            evaluationComputed: true,
            principalVariationComputed: true,
            search: {
              timing: r.snapshot.timing,
              coverage: r.snapshot.coverage,
              evaluation: r.snapshot.evaluation,
              nodes: r.snapshot.nodes,
              memoryBytes: r.snapshot.memoryBytes,
              diagnostics: r.snapshot.diagnostics,
              candidates: r.snapshot.candidates.slice(0, 3),
            },
          };
        } else {
          backgroundWindows++;
          forecast = r.snapshot;
        }
        await runtime.holdFocus?.(r.snapshot.id);
        if (way === "BASE") await runtime.cancel(r.snapshot.id);
      }
      if (side === seat) {
        choice ??= forcedLegalChoice(p);
        if (!choice?.action) throw Error("missing own action");
        action = choice.action;
        stats = { work: choice.work, completedDepth: choice.depth, cutoff: choice.cutoff };
      } else {
        const d = opponent.selector(p.state);
        action = d.action;
        stats = d.stats;
      }
      if (!action || !legal.some((a) => hashJson(a) === hashJson(action)))
        throw Error("illegal move");
      const event = { type: "action" as const, side, action };
      const next = await advanceAnalysisPosition(p, event);
      if (p.stateHash !== beforeHash) throw Error("mutated source");
      replay.events.push({ index: replay.events.length, event });
      journal({
        type: "move",
        event: replay.events.at(-1)!,
        beforeHash,
        afterHash: next.stateHash,
        decision: {
          side,
          playerId: lineup[side],
          elapsedMs: performance.now() - before,
          rssBytes: process.memoryUsage().rss,
          stats,
        },
        choice,
      });
      // Actual move is selected only after the background window. It never steers the forecast.
      if (forecast) {
        append(join(directory, id + "-actual.jsonl"), {
          ply,
          actual: event,
          predicted: forecast.focus?.prefix[0] ?? null,
          match: hashJson(forecast.focus?.prefix[0]?.action ?? null) === hashJson(action),
        });
      }
      p = next;
      if (!getActiveSides(p.state).includes(seat)) await runtime.releaseFocus?.();
      if (ply % 16 === 0)
        console.log(
          JSON.stringify({
            phase,
            way,
            seed,
            seat,
            ply,
            alive: getActiveSides(p.state).length,
            ownMoves,
            backgroundWindows,
          }),
        );
    }
    const game: RecordedGame = await replayStrengthJournal(
      readStrengthJournal(journalFile).entries,
      job,
      stopped,
    );
    const verification = await verifyStrengthGame(game, job, journalFile);
    const cpu = process.cpuUsage(parentCpu);
    const result = {
      source,
      way,
      seed,
      seat,
      phase,
      job,
      opponent: opponent.metadata,
      wallMs: performance.now() - started,
      parentCpuMs: (cpu.user + cpu.system) / 1000,
      workerCpuScope:
        "sum active worker slices in per-window snapshots; outer process-group CPU recorded separately",
      ownMoves,
      backgroundWindows,
      verification,
      game,
      result: resultLabels(p.state, seat),
    };
    save(output, result);
    append(join(directory, "completed.jsonl"), {
      id,
      way,
      seed,
      seat,
      status: game.sample.status,
      ...result.result,
      wallMs: result.wallMs,
    });
    console.log(
      JSON.stringify({ phase, way, seed, seat, status: game.sample.status, ...result.result }),
    );
  } catch (error) {
    save(join(directory, id + "-failure.json"), {
      source,
      way,
      seed,
      seat,
      phase,
      error: String(error),
      complete: false,
      events: replay.events.length,
    });
    throw error;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await runtime.close();
    opponent.dispose();
  }
}

if (import.meta.main) {
  const [root, command, ...args] = Bun.argv.slice(2);
  if (!root) throw Error("root required");
  if (command === "critical") await qualityFocus(root);
  else if (command === "time") await compareFocus(root);
  else if (command === "game") {
    const [phase, way, seed, seat] = args;
    if (
      !modes.includes(way as FocusWay) ||
      !sides.includes(seat as Side) ||
      !Number.isSafeInteger(Number(seed))
    )
      throw Error("invalid game condition");
    await playFocusGame(root, way as FocusWay, Number(seed), seat as Side, phase);
  } else throw Error("critical/time/game required");
}
