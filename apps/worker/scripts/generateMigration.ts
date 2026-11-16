import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../drizzle.config";

const worker = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const name = args[0];
if (args.length !== 1 || !/^[a-z][a-z0-9_]*$/.test(name))
  throw new Error("使い方: bun run db:generate -- <英小文字・数字・アンダースコアの名前>");

const out = resolve(worker, config.out!);
const migrations = join(worker, "migrations");
const lock = join(out, ".generate-lock");
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
mkdirSync(lock);
const temporary = mkdtempSync(join(out, ".generate-"));
try {
  const meta = join(out, "meta");
  const originalJournal = readFileSync(join(meta, "_journal.json"), "utf8");
  const journal = JSON.parse(originalJournal);
  cpSync(meta, join(temporary, "meta"), { recursive: true });
  const temporaryConfig = join(temporary, "config.ts");
  writeFileSync(
    temporaryConfig,
    `import config from "../../drizzle.config";\nexport default { ...config, out: ${JSON.stringify(relative(worker, temporary))} };\n`,
  );
  const kit = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs");
  const result = runGenerator(kit, temporaryConfig, temporary);
  if (!interactive) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  // drizzle-kitが例外時にも終了コード0を返す場合があるため、出力も検査します。
  if (result.error || result.status !== 0 || result.stderr)
    throw new Error("drizzle-kitの生成に失敗しました", { cause: result.error });
  const generated = readdirSync(temporary).filter((file) => file.endsWith(".sql"));
  const nextJournal = readFileSync(join(temporary, "meta", "_journal.json"), "utf8");
  if (generated.length === 0) {
    if (!result.stdout.includes("No schema changes") || nextJournal !== originalJournal)
      throw new Error("drizzle-kitの変更なし判定を確認できませんでした");
    console.log("変更なし: migrationsには何も追加しませんでした。");
  } else {
    const entries = JSON.parse(nextJournal).entries;
    if (generated.length !== 1 || entries.length !== journal.entries.length + 1)
      throw new Error("drizzle-kitの生成物が想定と異なります");
    const numbers = readdirSync(migrations).map((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1]);
    const next = Math.max(...numbers.filter((n) => n !== undefined).map(Number)) + 1;
    const filename = `${String(next).padStart(4, "0")}_${name}.sql`;
    const destination = join(migrations, filename);
    const entry = entries.at(-1);
    if (generated[0] !== `${entry.tag}.sql`) throw new Error("SQLとジャーナルの名前が一致しません");
    const snapshotName = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    const snapshot = readFileSync(join(temporary, "meta", snapshotName));
    const snapshotPath = join(meta, snapshotName);
    writeFileSync(destination, readFileSync(join(temporary, generated[0])), { flag: "wx" });
    let snapshotCreated = false;
    try {
      writeFileSync(snapshotPath, snapshot, { flag: "wx" });
      snapshotCreated = true;
      writeFileSync(join(meta, "_journal.json"), nextJournal);
    } catch (error) {
      rmSync(destination);
      if (snapshotCreated) rmSync(snapshotPath);
      writeFileSync(join(meta, "_journal.json"), originalJournal);
      throw error;
    }
    console.log(`生成しました: migrations/${filename}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(lock, { recursive: true, force: true });
}

function runGenerator(kit: string, temporaryConfig: string, temporary: string) {
  const args = [kit, "generate", "--config", temporaryConfig, "--name", name];
  const options = { cwd: worker, encoding: "utf8" as const };
  if (!interactive)
    return spawnSync(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  // 対話には端末を渡し、終了コード0の例外も判別できるよう出力を記録します。
  const transcript = join(temporary, "generator-output.log");
  const command = [process.execPath, ...args];
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", transcript, ...command]
      : [
          "-q",
          "-e",
          "-c",
          command.map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(" "),
          transcript,
        ];
  const result = spawnSync("script", scriptArgs, { ...options, stdio: "inherit" });
  return {
    ...result,
    stdout: existsSync(transcript) ? readFileSync(transcript, "utf8") : "",
    stderr: "",
  };
}
