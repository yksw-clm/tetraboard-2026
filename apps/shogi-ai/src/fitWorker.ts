import { fitCurriculum, preferenceLoss, type Curriculum, type Lesson } from "./curriculum";
import { aiModelSchema } from "@tetraboard/protocol/shogi-ai";
import { chooseLv3Action, lv3Weights } from "@tetraboard/four-shogi/lv3";
import { passesTacticalGate } from "./tacticalGate";
const [model, curriculum, output] = process.argv.slice(2);
const parent = aiModelSchema.parse(await Bun.file(model).json());
const dataset = (await Bun.file(curriculum).json()) as Curriculum;
const fit = fitCurriculum(parent, dataset);
const held = dataset.lessons.filter(
  (l) => l.profileId === parent.profileId && l.split === "holdout",
);
const training = dataset.lessons
  .filter((l) => l.profileId === parent.profileId && l.split === "train")
  .sort((a, b) => Number(b.difficult) - Number(a.difficult));
const groups = new Set<string>();
const focused = training.filter((l) => {
  if (groups.has(l.group)) return false;
  groups.add(l.group);
  return true;
});
for (const lesson of training)
  if (focused.length < 5 && !focused.includes(lesson)) focused.push(lesson);
const screen = focused.slice(0, 5);
const score = (lessons: Lesson[], weights: typeof parent.weights) => {
  let correct = 0,
    safe = 0;
  const initial = JSON.stringify(weights) === JSON.stringify(lv3Weights);
  for (const lesson of lessons) {
    if (initial) {
      correct += Number(!lesson.difficult);
      safe += Number(lesson.studentDepth > 0);
      continue;
    }
    const result = chooseLv3Action(lesson.state, { maxWork: parent.maxWork, weights });
    correct += Number(
      JSON.stringify(result.action) ===
        JSON.stringify(lesson.alternatives[lesson.preferred].state.lastMove?.action),
    );
    safe += Number(result.stats.safetyComplete);
  }
  return { correct, safe };
};
const baseline = fit.shortlist.length ? score(held, parent.weights) : null;
const baselineTrain = score(screen, parent.weights);
const ranked = fit.shortlist
  .map((weights) => ({ weights, ...score(screen, weights) }))
  .filter((c) => c.correct > baselineTrain.correct && c.safe >= baselineTrain.safe)
  .sort((a, b) => b.correct - a.correct)
  .slice(0, 2);
const checks = ranked.map((candidate) => ({ ...candidate, ...score(held, candidate.weights) }));
const weights = checks
  .filter((c) => baseline && c.correct >= baseline.correct && c.safe >= baseline.safe)
  .filter((c) => passesTacticalGate({ maxWork: parent.maxWork, weights: c.weights }))
  .map((c) => c.weights);
await Bun.write(
  output,
  JSON.stringify({
    weights,
    report: {
      ...fit.report,
      selected: weights.length,
      parentAgreement: baseline ? baseline.correct / held.length : null,
      candidateAgreement: checks.map((c) => c.correct / held.length),
      policyScreenLessons: screen.length,
      policyScreenCandidates: fit.shortlist.length,
      parentTrainAgreement: screen.length ? baselineTrain.correct / screen.length : null,
      candidateTrainAgreement: ranked.map((c) => c.correct / screen.length),
      candidateTrainLoss: weights.length ? preferenceLoss(training, weights[0]) : null,
      candidateHoldoutLoss: weights.length ? preferenceLoss(held, weights[0]) : null,
    },
  }),
);
