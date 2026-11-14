import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { profileNameSchema } from "./config";

export const seatSchema = z.strictObject({
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  playerId: z.uuid(),
});
export type Seat = z.infer<typeof seatSchema>;
const profileSchema = z.strictObject({ cookie: z.string().min(1), identity: z.string().min(1) });
export type Profile = z.infer<typeof profileSchema>;
export const stateSchema = z.strictObject({
  scope: z.string(),
  controllerId: z.uuid(),
  operationId: z.uuid().optional(),
  version: z.int().nonnegative().optional(),
  tournamentToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  seat: seatSchema.optional(),
  uncertain: z.boolean().optional(),
});
export type BotState = z.infer<typeof stateSchema>;
export class Store {
  readonly directory: string;
  private writes = Promise.resolve();
  constructor(
    origin: string,
    name: string,
    home = process.env.TETRABOARD_BOT_HOME ??
      join(homedir(), "Library/Application Support/TetraBoard Bot"),
  ) {
    profileNameSchema.parse(name);
    this.directory = join(home, createHash("sha256").update(origin).digest("hex"), name);
  }
  private async load<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await readFile(join(this.directory, file), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw Error("BOTの保存情報を読み取れません。保存先と権限を確認してください");
    }
  }
  loadProfile() {
    return this.load("profile.json", profileSchema);
  }
  loadState() {
    return this.load("state.json", stateSchema);
  }
  saveProfile(profile: Profile) {
    return this.save("profile.json", profileSchema.parse(profile));
  }
  saveState(state: BotState) {
    return this.save("state.json", stateSchema.parse(state));
  }
  private save(file: string, value: unknown): Promise<void> {
    const job = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `${file}.${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.directory, file));
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.writes = job.catch(() => {});
    return job;
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "run.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await unlink(path);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number(await readFile(path, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("BOTのロックを確認してください");
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(path);
            continue;
          }
        }
        throw Error("同じBOTプロフィールが別のプロセスで使用されています");
      }
    }
    throw Error("BOTのロックを取得できません");
  }
}
