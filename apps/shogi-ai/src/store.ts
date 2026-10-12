import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  aiModelSchema,
  type AiModel,
  type AiProfile,
  type AiRun,
} from "@tetraboard/protocol/shogi-ai";
import type { FourShogiState, Side } from "@tetraboard/four-shogi";
import type { Sample } from "./statistics";
export const profiles: AiProfile[] = ["singles-restricted", "singles-unrestricted"];
export type Task = {
  id: string;
  runId: string;
  modelId: string;
  opponentId: string;
  profileId: AiProfile;
  seed: number;
  seat: Side;
  maxPlies: number;
  pool: "tune" | "test";
};
export class AiStore {
  readonly db: Database;
  constructor(readonly directory: string) {
    mkdirSync(join(directory, "models"), { recursive: true });
    this.db = new Database(join(directory, "ai.sqlite"), { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, profile TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', state TEXT, events TEXT NOT NULL DEFAULT '[]', ply INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, result TEXT);",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id); CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,id); CREATE INDEX IF NOT EXISTS runs_profile ON runs(profile,id);",
    );
  }
  get<T>(key: string): T | null {
    const row = this.db
      .query<{ json: string }, [string]>("SELECT json FROM meta WHERE key=?")
      .get(key);
    return row ? (JSON.parse(row.json) as T) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .query("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json")
      .run(key, JSON.stringify(value));
  }
  model(id: string): AiModel {
    const row = this.db
      .query<{ json: string }, [string]>("SELECT json FROM models WHERE id=?")
      .get(id);
    if (!row) throw new Error("Unknown model");
    return aiModelSchema.parse(JSON.parse(row.json));
  }
  async saveModel(model: AiModel) {
    const data = JSON.stringify(aiModelSchema.parse(model), null, 2) + "\n";
    const file = join(this.directory, "models", model.id + ".json");
    const existing = this.db
      .query<{ json: string }, [string]>("SELECT json FROM models WHERE id=?")
      .get(model.id);
    if (existing && JSON.stringify(JSON.parse(existing.json)) !== JSON.stringify(model))
      throw new Error("Model version is immutable");
    await Bun.write(file, data);
    this.db
      .query("INSERT INTO models VALUES (?,?) ON CONFLICT DO NOTHING")
      .run(model.id, JSON.stringify(model));
  }
  saveRun(run: AiRun) {
    this.db
      .query("INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
      .run(run.id, run.profileId, JSON.stringify(run));
  }
  runs(profile?: AiProfile, cursor?: string): AiRun[] {
    return this.db
      .query<{ json: string }, [string | null, string | null, string | null]>(
        "SELECT json FROM runs WHERE COALESCE(?,profile)=profile AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 21",
      )
      .all(profile ?? null, cursor ?? null, cursor ?? null)
      .map((r) => JSON.parse(r.json));
  }
  latest(profile: AiProfile): AiRun | null {
    return this.db
      .query<{ json: string }, [string]>(
        "SELECT json FROM runs WHERE profile=? ORDER BY id DESC LIMIT 1",
      )
      .get(profile)?.json
      ? this.runs(profile)[0]
      : null;
  }
  addTask(task: Task) {
    this.db
      .query(
        "INSERT INTO tasks (id,run_id,json,updated_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(task.id, task.runId, JSON.stringify(task), Date.now());
  }
  task(id: string) {
    const row = this.db
      .query<
        {
          json: string;
          state: string | null;
          events: string;
          ply: number;
          result: string | null;
          status: string;
        },
        [string]
      >("SELECT * FROM tasks WHERE id=?")
      .get(id);
    if (!row) throw new Error("Unknown task");
    return {
      task: JSON.parse(row.json) as Task,
      state: row.state ? (JSON.parse(row.state) as FourShogiState) : null,
      events: JSON.parse(row.events) as unknown[],
      ply: row.ply,
      result: row.result ? (JSON.parse(row.result) as Sample) : null,
      status: row.status,
    };
  }
  pending(): Task[] {
    return this.db
      .query<{ json: string }, []>("SELECT json FROM tasks WHERE status='pending' ORDER BY id")
      .all()
      .map((r) => JSON.parse(r.json));
  }
  checkpoint(id: string, state: FourShogiState, events: unknown[], ply: number) {
    this.db
      .query("UPDATE tasks SET state=?,events=?,ply=?,updated_at=? WHERE id=? AND result IS NULL")
      .run(JSON.stringify(state), JSON.stringify(events), ply, Date.now(), id);
  }
  finish(id: string, sample: Sample) {
    this.db
      .query("UPDATE tasks SET status='done',result=?,updated_at=? WHERE id=? AND result IS NULL")
      .run(JSON.stringify(sample), Date.now(), id);
  }
  samples(runId: string, modelId: string, pool: "tune" | "test"): Sample[] {
    return this.db
      .query<{ json: string; result: string }, [string]>(
        "SELECT json,result FROM tasks WHERE run_id=? AND result IS NOT NULL",
      )
      .all(runId)
      .filter((r) => {
        const t = JSON.parse(r.json) as Task;
        return t.modelId === modelId && t.pool === pool;
      })
      .map((r) => JSON.parse(r.result));
  }
  close() {
    this.db.close();
  }
}
export async function sourceIdentity(): Promise<{ codeCommit: string; sourceHash: string }> {
  const root = join(import.meta.dir, "../../..");
  const folder = join(root, "packages/four-shogi/src");
  const training = import.meta.dir;
  const source = [folder, training]
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((n) => n.endsWith(".ts"))
        .sort()
        .map((n) => n + "\n" + readFileSync(join(dir, n), "utf8")),
    )
    .join("\n");
  const extra = [
    "packages/protocol/src/shogiAi.ts",
    "packages/four-shogi/bench/measurement.ts",
    "packages/four-shogi/bench/lv3Fixtures.ts",
    "packages/four-shogi/test/fixtures/lv3Positions.json",
  ]
    .map((name) => name + "\n" + readFileSync(join(root, name), "utf8"))
    .join("\n");
  let commit = "";
  try {
    const git = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    });
    commit = (await new Response(git.stdout).text()).trim();
    await git.exited;
  } catch {
    /* 配布用イメージにはGitを同梱しません。 */
  }
  return {
    codeCommit: process.env.AI_CODE_COMMIT ?? (commit || "source-archive"),
    sourceHash: new Bun.CryptoHasher("sha256").update(source + extra).digest("hex"),
  };
}
