import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("先行テストのtimeout後も次のテストは実AI Serviceへ接続できる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tb-ai-lifecycle-"));
  const fixture = join(directory, "lifecycle.test.ts");
  const helper = new URL("./localAiService.ts", import.meta.url).pathname;
  await Bun.write(
    fixture,
    `import { expect, test } from "bun:test";
import { useLocalAiService } from ${JSON.stringify(helper)};
const service = useLocalAiService();
test("intentional timeout", () => new Promise(() => {}), 50);
test("service health after timeout", async () => {
  expect((await fetch(service.url + "/health")).status).toBe(200);
});
`,
  );
  const child = Bun.spawn([process.execPath, "test", fixture], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = stdout + stderr;
    expect(code, output).toBe(1);
    expect(output).toContain("this test timed out after 50ms");
    expect(output).toContain("1 pass");
    expect(output).toContain("1 fail");
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
