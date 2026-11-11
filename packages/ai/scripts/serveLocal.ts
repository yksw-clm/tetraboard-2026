const path = new URL("../.env.local", import.meta.url);
const text = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "";
const token = process.env.AI_LOCAL_TOKEN ?? text.match(/^AI_LOCAL_TOKEN=([!-~]+)$/m)?.[1];
if (!token) throw Error("bun run --cwd packages/ai setup:local を先に実行してください");
const child = Bun.spawn(
  [
    "cargo",
    "run",
    "--release",
    "--locked",
    "-p",
    "tetraboard-ai-server",
    "--bin",
    "tetraboard-ai-local",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, AI_LOCAL_TOKEN: token },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
