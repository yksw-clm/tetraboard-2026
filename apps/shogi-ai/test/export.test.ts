import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiStore } from "../src/store";
test("exportはDBとJSONLを検証でき、status読取りでスナップショットを変更しません", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shogi-export-")),
    data = join(directory, "data"),
    output = join(directory, "output");
  const store = new AiStore(data);
  store.set("status", { value: "checkpoint" });
  store.close();
  const command = async (args: string[], root = data) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { ...process.env, AI_DATA_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text(),
      stderr = await new Response(child.stderr).text();
    return { code: await child.exited, stdout, stderr };
  };
  try {
    expect((await command(["export", output])).code).toBe(0);
    expect((await command(["verify-export", output])).code).toBe(0);
    expect(readFileSync(join(output, "matches.jsonl"), "utf8")).toBe("");
    const hash = () =>
      new Bun.CryptoHasher("sha256").update(readFileSync(join(output, "ai.sqlite"))).digest("hex");
    const before = hash();
    expect(JSON.parse((await command(["status"], output)).stdout)).toEqual({ value: "checkpoint" });
    expect(hash()).toBe(before);
    await Bun.write(join(output, "matches.jsonl"), "corrupted");
    expect((await command(["verify-export", output])).code).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
