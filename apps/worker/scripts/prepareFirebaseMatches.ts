import { readFile, writeFile } from "node:fs/promises";
import { argv } from "node:process";
import { prepareFirebaseMatches } from "./firebaseMatchPlan";
const [sourceDirectory, linksPath, targetPath, outputPath] = argv.slice(2);
if (!sourceDirectory || !linksPath || !targetPath || !outputPath)
  throw new Error(
    "Usage: bun scripts/prepareFirebaseMatches.ts <export-directory> <links.json> <target.json> <output.sql>",
  );
const source = (
  await Promise.all(
    ["four-reversi", "four-shogi"].map(
      async (game) =>
        JSON.parse(await readFile(`${sourceDirectory}/${game}/matches.json`, "utf8")) as unknown[],
    ),
  )
).flat();
const plan = prepareFirebaseMatches(
  source,
  JSON.parse(await readFile(linksPath, "utf8")),
  JSON.parse(await readFile(targetPath, "utf8")),
);
await writeFile(outputPath, plan.sql, { mode: 0o600 });
await writeFile(
  `${outputPath}.plan.json`,
  JSON.stringify({ matches: plan.matches, skipped: plan.skipped }, null, 2),
  { mode: 0o600 },
);
console.log(
  `Prepared ${plan.matches.length} verified matches; skipped ${plan.skipped.length}. No database was modified.`,
);
