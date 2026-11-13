import { chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { nativeHostName } from "../src/serviceProtocol";
import { extensionIdForPath, readLocalToken } from "./installation";

if (process.platform !== "darwin")
  throw Error("setup:nativeはmacOS版Google Chromeに対応しています");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "extension-dir": { type: "string" },
    "extension-id": { type: "string" },
    "token-file": { type: "string" },
  },
});
const widget = resolve(import.meta.dir, "..");
const repo = resolve(widget, "../..");
const extensionDir = resolve(values["extension-dir"] ?? join(widget, "dist"));
const tokenFile = resolve(values["token-file"] ?? join(repo, "packages/ai/.env.local"));
const installDir = join(homedir(), "Library/Application Support/TetraBoard/LocalAI");
const registrationDir = join(
  homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
);
async function run(args: string[], cwd = widget) {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw Error("ビルドに失敗しました。上の出力を確認してください");
}
if (!(await Bun.file(tokenFile).exists())) {
  await mkdir(resolve(tokenFile, ".."), { recursive: true });
  await writeFile(
    tokenFile,
    `AI_LOCAL_TOKEN=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
const token = readLocalToken(await Bun.file(tokenFile).text());
await run([process.execPath, "run", "build"]);
await run(
  [
    "cargo",
    "build",
    "--release",
    "--locked",
    "-p",
    "tetraboard-ai-server",
    "--bin",
    "tetraboard-ai-local",
  ],
  join(repo, "packages/ai"),
);
const staging = await mkdtemp(join(tmpdir(), "tetraboard-native-"));
try {
  await run([
    process.execPath,
    "build",
    "--compile",
    "./native/host.ts",
    "--outfile",
    join(staging, "tetraboard-native"),
  ]);
  await mkdir(extensionDir, { recursive: true });
  const sourceDist = await realpath(join(widget, "dist"));
  const destinationDist = await realpath(extensionDir);
  if (sourceDist !== destinationDist) {
    for (const file of [
      "manifest.json",
      "options.html",
      "bridge.js",
      "content.js",
      "background.js",
      "options.js",
    ])
      await copyFile(join(sourceDist, file), join(destinationDist, file));
  }
  const extensionId = values["extension-id"] ?? extensionIdForPath(destinationDist);
  if (!/^[a-p]{32}$/.test(extensionId)) throw Error("拡張IDが不正です");
  const origin = `chrome-extension://${extensionId}/`;
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  await chmod(installDir, 0o700);
  for (const [source, name] of [
    [join(staging, "tetraboard-native"), "tetraboard-native"],
    [join(repo, "packages/ai/target/release/tetraboard-ai-local"), "tetraboard-ai-local"],
  ]) {
    const destination = join(installDir, name);
    await copyFile(source, `${destination}.new`);
    await chmod(`${destination}.new`, 0o700);
    await rename(`${destination}.new`, destination);
  }
  const configPath = join(installDir, "native-config.json");
  await writeFile(`${configPath}.new`, JSON.stringify({ version: 1, origin, token }), {
    mode: 0o600,
  });
  await chmod(`${configPath}.new`, 0o600);
  await rename(`${configPath}.new`, configPath);
  await mkdir(registrationDir, { recursive: true });
  await writeFile(
    join(registrationDir, `${nativeHostName}.json`),
    JSON.stringify(
      {
        name: nativeHostName,
        description: "TetraBoard local AI service controller",
        path: join(installDir, "tetraboard-native"),
        type: "stdio",
        allowed_origins: [origin],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `登録しました。拡張ID: ${extensionId}\nChromeへ読み込むフォルダー: ${destinationDist}\n拡張と対局ページを再読み込みし、widgetの「AI起動」「有効にする」を押してください。`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
