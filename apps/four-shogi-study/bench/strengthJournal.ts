import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceAnalysisPosition, restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { hashJson, resultLabels } from "../../../packages/four-shogi/bench/singlesMeasurement";
import type { RecordedGame, StrengthGameObserver, StrengthJob } from "./strength";

export type StrengthJournalEntry = Parameters<StrengthGameObserver>[0];
export function createStrengthJournal(directory: string): StrengthGameObserver {
  mkdirSync(directory, { recursive: true });
  let path: string | null = null;
  return (entry) => {
    const row = JSON.stringify({ ...entry, pid: process.pid, at: new Date().toISOString() }) + "\n";
    if (entry.type === "start") {
      if (!/^[a-f0-9]+$/.test(entry.job.id)) throw new Error("不正な対局IDです");
      path = join(directory, `${entry.job.id}.jsonl`);
      writeFileSync(path, row, { flag: "wx" });
    } else {
      if (!path) throw new Error("対局開始前の着手です");
      // 対局親が落ちた場合も、適用済みの合法手を各着手の境界で保全します。
      appendFileSync(path, row);
    }
  };
}

export function readStrengthJournal(path: string) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const entries: StrengthJournalEntry[] = [];
  let truncatedTail = false;
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (index !== lines.length - 1 || raw.endsWith("\n")) throw error;
      truncatedTail = true;
    }
  }
  return { entries, truncatedTail };
}

export async function replayStrengthJournal(
  entries: readonly StrengthJournalEntry[],
  expected: StrengthJob,
  interrupted = true,
): Promise<RecordedGame> {
  const start = entries[0];
  if (start?.type !== "start" || hashJson(start.job) !== hashJson(expected))
    throw new Error("対局開始条件が計画と一致しません");
  if (start.replay.events.length !== 12) throw new Error("開始棋譜は12手です");
  const replay = { ...start.replay, events: [...start.replay.events] };
  let position = await restoreAnalysisPosition(replay);
  if (position.stateHash !== start.stateHash) throw new Error("開始hashが一致しません");
  if (position.state.threePlayerAttackProhibited !== expected.restricted)
    throw new Error("禁止設定が一致しません");
  const decisions: RecordedGame["sample"]["decisions"] = [];
  const candidateElapsedMs: number[] = [];
  const candidateDepths: number[] = [];
  const candidateReasons: Record<string, number> = {};
  for (const row of entries.slice(1)) {
    if (row.type !== "move" || row.event.index !== replay.events.length)
      throw new Error("着手の連番が不正です");
    if (row.beforeHash !== position.stateHash || row.decision.side !== position.state.turn)
      throw new Error("着手前hashまたは手番が一致しません");
    if (row.decision.playerId !== start.lineup[row.decision.side])
      throw new Error("着手者が一致しません");
    if ((row.choice !== null) !== (row.decision.side === expected.seat))
      throw new Error("候補AIの記録が一致しません");
    if (row.choice) {
      if (
        row.event.event.type !== "action" ||
        hashJson(row.choice.action) !== hashJson(row.event.event.action)
      )
        throw new Error("推奨手と実着手が一致しません");
      if (
        hashJson(row.decision.stats) !==
        hashJson({
          work: row.choice.work,
          completedDepth: row.choice.depth,
          cutoff: row.choice.cutoff,
        })
      )
        throw new Error("探索統計が一致しません");
      candidateElapsedMs.push(row.choice.elapsedMs);
      candidateDepths.push(row.choice.depth);
      candidateReasons[row.choice.reason] = (candidateReasons[row.choice.reason] ?? 0) + 1;
    }
    position = await advanceAnalysisPosition(position, row.event.event);
    if (row.afterHash !== position.stateHash) throw new Error("着手後hashが一致しません");
    replay.events.push(row.event);
    decisions.push(row.decision);
  }
  const sample: RecordedGame["sample"] = {
    matchId: expected.id,
    seriesId: hashJson({ openingSeed: expected.seed, openingPlies: 12 }),
    startKind: "opening",
    seed: expected.seed,
    seat: expected.seat,
    lineup: start.lineup,
    status: position.state.status === "finished" ? "finished" : "unfinished",
    moves: decisions.length,
    ...resultLabels(position.state, expected.seat),
    termination:
      position.state.status === "finished"
        ? position.state.result.reason
        : interrupted
          ? "interrupted"
          : "max_plies",
    eliminations: position.state.eliminations,
    finalStateHash: position.stateHash,
    trajectoryHash: hashJson(replay.events),
    decisions,
  };
  return {
    jobId: expected.id,
    searchStrategy: expected.searchStrategy,
    lane: start.lane,
    profile: expected.profile,
    restricted: expected.restricted,
    sample,
    replay,
    candidateElapsedMs,
    candidateDepths,
    candidateReasons,
    interrupted,
  };
}

export async function verifyStrengthGame(game: RecordedGame, job: StrengthJob, path: string) {
  const journal = readStrengthJournal(path);
  if (journal.truncatedTail) throw new Error("完成局のjournal末尾が欠けています");
  const reconstructed = await replayStrengthJournal(journal.entries, job, game.interrupted);
  if (hashJson(reconstructed) !== hashJson(game))
    throw new Error("正本再生と対局記録・順位・統計が一致しません");
  return {
    jobId: game.jobId,
    events: game.replay.events.length,
    moves: game.sample.moves,
    finalStateHash: game.sample.finalStateHash,
    resultLabels: resultLabels((await restoreAnalysisPosition(game.replay)).state, job.seat),
    verified: true,
  };
}
