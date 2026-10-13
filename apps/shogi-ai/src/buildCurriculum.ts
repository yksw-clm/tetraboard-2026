import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { aiModelSchema, aiProfileSchema } from "@tetraboard/protocol/shogi-ai";
import { lessonJobs, type Curriculum, type CurriculumInput, type Lesson } from "./curriculum";
import { sourceIdentity } from "./store";

export async function buildCurriculum(args: string[]) {
  const started = performance.now();
  const [sourcePath, destination, ...flags] = args;
  if (!sourcePath || !destination)
    throw new Error(
      "Usage: curriculum SOURCE_JSONL OUTPUT_JSON [--workers 5 --student-work 16384 --teacher-work 65536 --lessons 96]",
    );
  const options = { workers: 5, studentWork: 16384, teacherWork: 65536, lessons: 96 };
  const keys = {
    "--workers": "workers",
    "--student-work": "studentWork",
    "--teacher-work": "teacherWork",
    "--lessons": "lessons",
  } as const;
  for (let i = 0; i < flags.length; i += 2) {
    const key = keys[flags[i] as keyof typeof keys],
      value = Number(flags[i + 1]);
    if (!key || !Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid curriculum options");
    options[key] = value;
  }
  if (
    options.workers > 5 ||
    options.lessons > 256 ||
    options.studentWork < 128 ||
    options.teacherWork > 262144 ||
    options.teacherWork <= options.studentWork
  )
    throw new Error("Curriculum options out of range");
  const source = Bun.file(sourcePath);
  if (source.size > 256 * 1024 ** 2) throw new Error("Curriculum source is too large");
  const text = await source.text(),
    games: CurriculumInput[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const game = JSON.parse(line) as CurriculumInput;
    if (game.task.pool !== "tune") continue;
    aiProfileSchema.parse(game.task.profileId);
    if (
      !Number.isSafeInteger(game.task.seed) ||
      !Array.isArray(game.events) ||
      game.events.length > 800
    )
      throw new Error("Invalid curriculum replay");
    if (!game.sourceHash) {
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(game.task.modelId))
        throw new Error("Invalid source model id");
      const model = aiModelSchema.parse(
        await Bun.file(
          join(dirname(resolve(sourcePath)), "models", game.task.modelId + ".json"),
        ).json(),
      );
      game.sourceHash = model.sourceHash;
      game.codeCommit = model.codeCommit;
    }
    games.push(game);
  }
  const jobs = lessonJobs(games, options.lessons);
  const identity = await sourceIdentity();
  const output = resolve(destination);
  mkdirSync(dirname(output), { recursive: true });
  const temp = mkdtempSync(join(dirname(output), ".curriculum-"));
  const lessons: (Lesson | null)[] = Array(jobs.length).fill(null);
  const running = new Set<ReturnType<typeof Bun.spawn>>();
  let next = 0,
    finished = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(options.workers, jobs.length) }, async () => {
        while (next < jobs.length) {
          const index = next++,
            input = join(temp, `${index}.input.json`),
            result = join(temp, `${index}.output.json`);
          await Bun.write(input, JSON.stringify(jobs[index]));
          const child = Bun.spawn(
            [
              process.execPath,
              join(import.meta.dir, "curriculumWorker.ts"),
              input,
              result,
              String(options.studentWork),
              String(options.teacherWork),
            ],
            { stdout: "ignore", stderr: "ignore" },
          );
          running.add(child);
          const timeout = setTimeout(() => child.kill("SIGKILL"), 90000);
          const code = await child.exited;
          clearTimeout(timeout);
          running.delete(child);
          if (code !== 0) throw new Error(`Teacher process failed (${code})`);
          lessons[index] = await Bun.file(result).json();
          finished++;
          console.log(
            JSON.stringify({
              stage: "teaching",
              completed: lessons.filter(Boolean).length,
              examined: finished,
              planned: jobs.length,
            }),
          );
        }
      }),
    );
    const dataset: Curriculum = {
      version: 1,
      sourceHash: identity.sourceHash,
      sourceGamesHash: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      teacherWork: options.teacherWork,
      studentWork: options.studentWork,
      lessons: lessons.filter((l): l is Lesson => !!l),
    };
    await Bun.write(output, JSON.stringify(dataset));
    console.log(
      JSON.stringify({
        stage: "curriculum-ready",
        output,
        lessons: dataset.lessons.length,
        difficult: dataset.lessons.filter((l) => l.difficult).length,
        elapsedMs: Math.round(performance.now() - started),
        profiles: (["singles-restricted", "singles-unrestricted"] as const).map((profile) => ({
          profile,
          train: dataset.lessons.filter((l) => l.profileId === profile && l.split === "train")
            .length,
          holdout: dataset.lessons.filter((l) => l.profileId === profile && l.split === "holdout")
            .length,
        })),
      }),
    );
  } finally {
    for (const child of running) child.kill("SIGKILL");
    await Promise.allSettled([...running].map((child) => child.exited));
    rmSync(temp, { recursive: true, force: true });
  }
}
