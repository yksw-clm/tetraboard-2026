import { teachLesson, type LessonJob } from "./curriculum";
const [input, output, student, teacher] = process.argv.slice(2);
const job: LessonJob = await Bun.file(input).json();
await Bun.write(output, JSON.stringify(teachLesson(job, Number(student), Number(teacher))));
