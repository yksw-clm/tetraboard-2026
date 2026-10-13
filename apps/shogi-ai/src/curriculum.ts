import { applyAction, type FourShogiState, type FourShogiAction } from "@tetraboard/four-shogi";
import {
  chooseLv3Action,
  evaluateLv3Position,
  lv3Weights,
  type Lv3RootCandidate,
} from "@tetraboard/four-shogi/lv3";
import { aiWeightsSchema, type AiModel, type AiProfile } from "@tetraboard/protocol/shogi-ai";
import { openingPosition, seededRandom } from "../../../packages/four-shogi/bench/measurement";
import type { Task } from "./store";

export type CurriculumInput = {
  task: Task;
  events: { type: "action"; side: FourShogiState["turn"]; action: FourShogiAction }[];
  sourceHash: string;
  codeCommit: string;
};
export type LessonJob = {
  id: string;
  group: string;
  profileId: AiProfile;
  split: "train" | "holdout";
  state: FourShogiState;
  sourceHash: string;
};
export type Lesson = LessonJob & {
  teacherDepth: number;
  studentDepth: number;
  difficult: boolean;
  preferred: number;
  alternatives: { state: FourShogiState; risk: number }[];
};
export type Curriculum = {
  version: 1;
  sourceHash: string;
  sourceGamesHash: string;
  teacherWork: number;
  studentWork: number;
  lessons: Lesson[];
};
export function validateCurriculum(
  value: Curriculum,
  sourceHash: string,
  work: number,
): Curriculum {
  if (
    value.version !== 1 ||
    value.sourceHash !== sourceHash ||
    value.studentWork !== work ||
    !Number.isSafeInteger(value.teacherWork) ||
    value.teacherWork <= work ||
    value.teacherWork > 262144 ||
    !Array.isArray(value.lessons) ||
    value.lessons.length > 256
  )
    throw new Error("Curriculum belongs to another source/budget");
  const groups = new Map<string, string>();
  for (const lesson of value.lessons) {
    if (lesson.split !== "train" && lesson.split !== "holdout")
      throw new Error("Invalid curriculum split");
    if (groups.has(lesson.group) && groups.get(lesson.group) !== lesson.split)
      throw new Error("Curriculum group leaks across splits");
    groups.set(lesson.group, lesson.split);
    if (
      lesson.state.mode !== "singles" ||
      lesson.state.status !== "playing" ||
      !["singles-restricted", "singles-unrestricted"].includes(lesson.profileId) ||
      lesson.state.threePlayerAttackProhibited !== (lesson.profileId === "singles-restricted") ||
      !Number.isSafeInteger(lesson.preferred) ||
      lesson.preferred < 0 ||
      lesson.preferred >= lesson.alternatives.length ||
      lesson.alternatives.length < 2 ||
      lesson.alternatives.length > 12 ||
      lesson.alternatives.some((a) => !Number.isFinite(a.risk) || a.risk < 0) ||
      lesson.teacherDepth <= lesson.studentDepth
    )
      throw new Error("Invalid curriculum lesson");
  }
  return value;
}
export const weightBounds: Record<keyof typeof lv3Weights, [number, number]> = {
  undefended: [0.5, 3],
  exchange: [0.3, 2],
  kingRing: [10, 120],
  check: [0, 200],
  mobility: [0, 10],
  advancement: [0, 20],
  shelter: [0, 50],
  survival: [3000, 7000],
};
const actionKey = (action: FourShogiAction | null) => JSON.stringify(action);

/** 席・棋譜・途中局面を同じ開始系列の集合へ固定し、検証用対局を学習に流用しません。 */
export function lessonJobs(games: CurriculumInput[], maximum: number): LessonJob[] {
  const unique = new Set<string>();
  const jobs: LessonJob[] = [];
  for (const game of games) {
    if (game.task.pool !== "tune") continue;
    const group = `${game.task.profileId}:${game.task.seed}`;
    const split = seededRandom(game.task.seed)() < 0.25 ? "holdout" : "train";
    let state = openingPosition(
      "singles",
      game.task.profileId === "singles-restricted",
      game.task.seed,
    );
    let sampled = 0,
      previousPly = 0;
    for (const [index, event] of game.events.entries()) {
      if (state.status !== "playing" || event.type !== "action" || event.side !== state.turn)
        throw new Error("Invalid replay event");
      if (
        index >= 24 &&
        index - previousPly >= 24 &&
        state.turn === game.task.seat &&
        sampled < 4
      ) {
        const id = `${group}:${game.task.seat}:${index}`;
        const profileCount = jobs.filter((j) => j.profileId === game.task.profileId).length;
        if (!unique.has(id) && profileCount < Math.floor(maximum / 2)) {
          jobs.push({
            id,
            group,
            split,
            profileId: game.task.profileId,
            state,
            sourceHash: game.sourceHash,
          });
          unique.add(id);
          sampled++;
          previousPly = index;
        }
      }
      const result = applyAction(state, event.side, event.action);
      if (!result.ok) throw new Error("Illegal replay action");
      state = result.state;
    }
  }
  return jobs;
}

export function teachLesson(
  job: LessonJob,
  studentWork: number,
  teacherWork: number,
): Lesson | null {
  const student = chooseLv3Action(job.state, { maxWork: studentWork });
  let roots: readonly Lv3RootCandidate[] = [];
  const teacher = chooseLv3Action(job.state, {
    maxWork: teacherWork,
    onRootCandidates: (values) => {
      roots = values;
    },
  });
  if (
    !student.action ||
    !teacher.action ||
    !teacher.stats.safetyComplete ||
    teacher.stats.completedDepth <= student.stats.completedDepth ||
    roots.length < 2
  )
    return null;
  const selected = roots.find((r) => actionKey(r.action) === actionKey(teacher.action));
  if (!selected) return null;
  const rivals = roots.filter((r) => r !== selected).slice(0, 11);
  return {
    ...job,
    teacherDepth: teacher.stats.completedDepth,
    studentDepth: student.stats.completedDepth,
    difficult: actionKey(teacher.action) !== actionKey(student.action),
    preferred: 0,
    alternatives: [selected, ...rivals].map((r) => ({ state: r.state, risk: r.risk })),
  };
}

export function preferenceLoss(lessons: Lesson[], weights: AiModel["weights"]): number {
  if (!lessons.length) return Infinity;
  let total = 0,
    importance = 0;
  for (const lesson of lessons) {
    const turn = lesson.state.turn;
    if (turn === null) throw new Error("Curriculum root must be playing");
    const values = lesson.alternatives.map(
      (a) => evaluateLv3Position(a.state, weights)[turn] - a.risk,
    );
    const target = values[lesson.preferred];
    const losses = values
      .filter((_, i) => i !== lesson.preferred)
      .map((value) => Math.log1p(Math.exp(Math.max(-30, Math.min(30, (value - target) / 100)))))
      .sort((a, b) => b - a)
      .slice(0, 3);
    const factor = lesson.difficult ? 3 : 1;
    total += (factor * losses.reduce((a, b) => a + b, 0)) / Math.max(1, losses.length);
    importance += factor;
  }
  return total / importance;
}

/** 教師局面を再探索せずに座標探索し、別の開始系列で悪化した提案を除外します。 */
export function fitCurriculum(parent: AiModel, curriculum: Curriculum) {
  const lessons = curriculum.lessons.filter((l) => l.profileId === parent.profileId);
  const train = lessons.filter((l) => l.split === "train"),
    holdout = lessons.filter((l) => l.split === "holdout");
  const enough =
    train.length >= 8 &&
    holdout.length >= 4 &&
    new Set(train.map((l) => l.group)).size >= 2 &&
    new Set(holdout.map((l) => l.group)).size >= 1;
  const baseTrain = preferenceLoss(train, parent.weights),
    baseHoldout = preferenceLoss(holdout, parent.weights);
  const proposals: { weights: AiModel["weights"]; train: number; holdout: number }[] = [];
  const diverse: AiModel["weights"][] = [];
  let examined = 0,
    best = parent.weights;
  if (enough) {
    for (const fraction of [0.25, 0.15, 0.08, 0.04]) {
      const round: typeof proposals = [];
      for (const key of Object.keys(weightBounds) as (keyof typeof lv3Weights)[]) {
        const axis: typeof proposals = [];
        for (const direction of [-1, 1]) {
          const [low, high] = weightBounds[key],
            scale = Math.max(parent.weights[key], (high - low) * 0.1);
          const weights = aiWeightsSchema.parse({
            ...best,
            [key]: Math.max(low, Math.min(high, best[key] + direction * fraction * scale)),
          });
          const trainLoss = preferenceLoss(train, weights),
            holdoutLoss = preferenceLoss(holdout, weights);
          examined++;
          const distance = (Object.keys(weightBounds) as (keyof typeof lv3Weights)[]).reduce(
            (n, k) => n + ((weights[k] - parent.weights[k]) / Math.max(1, parent.weights[k])) ** 2,
            0,
          );
          const proposal = { weights, train: trainLoss + 0.02 * distance, holdout: holdoutLoss };
          round.push(proposal);
          axis.push(proposal);
        }
        if (fraction === 0.25) diverse.push(axis.sort((a, b) => a.train - b.train)[0].weights);
      }
      round.sort((a, b) => a.train - b.train);
      if (round[0].train < preferenceLoss(train, best)) best = round[0].weights;
      proposals.push(...round);
    }
  }
  const seen = new Set<string>();
  const selected = proposals
    .sort((a, b) => a.train - b.train)
    .filter(
      (p) =>
        p.train < baseTrain &&
        p.holdout <= baseHoldout &&
        JSON.stringify(p.weights) !== JSON.stringify(parent.weights),
    )
    .filter((p) => {
      const key = JSON.stringify(p.weights);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
  return {
    weights: selected.map((p) => p.weights),
    shortlist: [
      ...new Map(
        [...diverse, ...selected.map((p) => p.weights)].map((weights) => [
          JSON.stringify(weights),
          weights,
        ]),
      ).values(),
    ],
    report: {
      lessons: train.length,
      holdoutLessons: holdout.length,
      examined,
      selected: selected.length,
      baselineTrainLoss: Number.isFinite(baseTrain) ? baseTrain : null,
      baselineHoldoutLoss: Number.isFinite(baseHoldout) ? baseHoldout : null,
      candidateTrainLoss: selected[0]?.train ?? null,
      candidateHoldoutLoss: selected[0]?.holdout ?? null,
    },
  };
}
