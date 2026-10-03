import { readFile, writeFile } from "node:fs/promises";
import { argv } from "node:process";
import {
  prepareLegacyAccounts,
  readSnapshot,
  type LegacyAccountExclusion,
} from "./legacyAccountPlan";
const [sourcePath, targetPath, outputPath, exclusionsPath] = argv.slice(2);
if (!sourcePath || !targetPath || !outputPath)
  throw new Error(
    "Usage: bun scripts/prepareLegacyAccounts.ts <source.json> <target.json> <output.sql> [exclusions.json]",
  );
const plan = prepareLegacyAccounts(
  readSnapshot(JSON.parse(await readFile(sourcePath, "utf8"))),
  readSnapshot(JSON.parse(await readFile(targetPath, "utf8"))),
  exclusionsPath
    ? (JSON.parse(await readFile(exclusionsPath, "utf8")) as LegacyAccountExclusion[])
    : [],
);
await writeFile(outputPath, plan.sql, { mode: 0o600 });
await writeFile(`${outputPath}.avatars.json`, JSON.stringify(plan.avatars, null, 2), {
  mode: 0o600,
});
console.log(
  `Prepared ${plan.users} accounts and ${plan.avatars.length} avatar copies. No remote resources were modified.`,
);
