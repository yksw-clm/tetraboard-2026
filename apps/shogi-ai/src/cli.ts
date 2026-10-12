import { mkdirSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { resolve, join } from "node:path";
import { AiStore, profiles } from "./store";
import { Trainer, parseOptions } from "./training";
import { createApi } from "./server";
import { chooseLv3Action } from "@tetraboard/four-shogi/lv3";
import { openingPosition } from "../../../packages/four-shogi/bench/measurement";
import { Database } from "bun:sqlite";
const [command, ...args] = process.argv.slice(2);
const directory = resolve(process.env.AI_DATA_DIR ?? ".shogi-ai");
if (command === "status") {
  const db = new Database(join(directory, "ai.sqlite"), { readonly: true });
  const row = db.query<{ json: string }, []>("SELECT json FROM meta WHERE key='status'").get();
  console.log(JSON.stringify(row ? JSON.parse(row.json) : null, null, 2));
  db.close();
  process.exit(0);
}
if (command === "verify-export") {
  await verifyExport(resolve(args[0] ?? ""));
  process.exit(0);
}
const store = new AiStore(directory);
if (command === "serve" || command === "train") {
  const options = parseOptions(args);
  const api =
    command === "serve"
      ? Bun.serve({
          hostname: process.env.AI_HOST ?? "127.0.0.1",
          port: Number(process.env.AI_PORT ?? 8090),
          fetch: createApi(store, process.env.AI_MONITOR_KEY ?? ""),
        })
      : null;
  const trainer = new Trainer(store, options);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    if (heartbeat) clearInterval(heartbeat);
    await trainer.stop();
    api?.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void finish();
  });
  process.on("SIGINT", () => {
    void finish();
  });
  await trainer.start();
  if (api) heartbeat = setInterval(() => trainer.snapshot(), 5000);
  console.log(
    JSON.stringify({
      stage: "started",
      workers: options.workers,
      seconds: options.seconds,
      data: directory,
    }),
  );
  // 時間切れ後はAPIで最終状況を閲覧できます。train単体は終了します。
  if (!api)
    setTimeout(
      () => {
        void finish();
      },
      Math.max(0, (store.get<number>("endsAt") ?? Date.now()) - Date.now()) + 6000,
    );
} else if (command === "export") {
  if (!args[0]) throw new Error("Usage: export OUTPUT_DIRECTORY");
  const destination = resolve(args[0]);
  if (destination === directory || destination.startsWith(directory + "/"))
    throw new Error("Export outside AI_DATA_DIR");
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length) throw new Error("Export directory must be empty");
  mkdirSync(join(destination, "models"));
  store.db.query("VACUUM INTO ?").run(join(destination, "ai.sqlite"));
  const checksums: Record<string, string> = {};
  for (const name of readdirSync(join(directory, "models")).filter((n) => n.endsWith(".json"))) {
    const relative = "models/" + name,
      data = readFileSync(join(directory, relative));
    await Bun.write(join(destination, relative), data);
    checksums[relative] = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  }
  const writer = Bun.file(join(destination, "matches.jsonl")).writer();
  let games = 0;
  for (const r of store.db
    .query<{ json: string; events: string; result: string | null }, []>(
      "SELECT json,events,result FROM tasks WHERE result IS NOT NULL ORDER BY id",
    )
    .iterate()) {
    writer.write(
      JSON.stringify({
        task: JSON.parse(r.json),
        events: JSON.parse(r.events),
        result: JSON.parse(r.result!),
      }) + "\n",
    );
    games++;
    if (games % 64 === 0) await writer.flush();
  }
  await writer.end();
  for (const name of ["ai.sqlite", "matches.jsonl"])
    checksums[name] = await fileHash(join(destination, name));
  await Bun.write(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: Date.now(),
        checksums,
        champions: Object.fromEntries(profiles.map((p) => [p, store.get(`champion:${p}`)])),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ stage: "exported", directory: destination, games }));
  store.close();
} else if (command === "benchmark") {
  const count = Number(args[0] ?? 10);
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("Invalid benchmark count");
  for (const restricted of [true, false])
    for (const maxWork of [16384, 65536, 262144]) {
      const times: number[] = [],
        depths: number[] = [];
      let safe = 0;
      for (let i = 0; i < count; i++) {
        const position = openingPosition("singles", restricted, 2000000000 + i);
        const start = performance.now();
        const result = chooseLv3Action(position, { maxWork });
        times.push(performance.now() - start);
        depths.push(result.stats.completedDepth);
        safe += Number(result.stats.safetyComplete);
      }
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          restricted,
          maxWork,
          positions: count,
          p50Ms: times[Math.floor((count - 1) * 0.5)],
          p95Ms: times[Math.ceil(count * 0.95) - 1],
          meanDepth: depths.reduce((a, b) => a + b, 0) / count,
          safetyCompleted: safe,
        }),
      );
    }
  store.close();
} else if (command === "preflight") {
  const disk = statfsSync(directory);
  const result = {
    bun: Bun.version,
    arch: process.arch,
    diskFreeGiB: (disk.bavail * disk.bsize) / 1024 ** 3,
    monitorConfigured: (process.env.AI_MONITOR_KEY?.length ?? 0) >= 32,
  };
  console.log(JSON.stringify(result));
  store.close();
  if (result.diskFreeGiB < 20) process.exit(1);
} else {
  store.close();
  throw new Error("Commands: serve, train, status, export, verify-export, benchmark, preflight");
}
async function verifyExport(root: string) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error("Unknown export version");
  if (
    !manifest.checksums ||
    !["ai.sqlite", "matches.jsonl"].every((name) => /^[a-f0-9]{64}$/.test(manifest.checksums[name]))
  )
    throw new Error("Incomplete manifest");
  for (const [name, hash] of Object.entries(manifest.checksums)) {
    if (!/^(ai\.sqlite|matches\.jsonl|models\/[a-zA-Z0-9_-]+\.json)$/.test(name))
      throw new Error("Invalid manifest path");
    if ((await fileHash(join(root, name))) !== hash) throw new Error(`Checksum failed: ${name}`);
  }
  console.log("Export checksums verified");
}
async function fileHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return hash.digest("hex");
}
