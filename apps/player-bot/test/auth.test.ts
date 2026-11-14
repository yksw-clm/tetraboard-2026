import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { ids } from "./fixtures";

test("実CLIで接続先の旧規約版の同意を確認して認証情報を保存し、未同意では上書きしない", async () => {
  const home = await mkdtemp(join(tmpdir(), "tb48-auth-"));
  let accepted = true;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/api/account/session")
        return Response.json({
          user: {
            profileId: ids[0],
            username: "bot1",
            name: "BOT-1",
            avatarUrl: null,
            profileCompleted: true,
          },
        });
      if (path === "/api/account/legal") return Response.json({ accepted, version: "2026-11-11" });
      return new Response(null, { status: 404 });
    },
  });
  const origin = server.url.origin;
  const store = new Store(origin, "hase", home);
  const auth = async (cookie: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.ts", import.meta.url).pathname,
        "auth",
        "hase",
        "--origin",
        origin,
      ],
      {
        env: { ...process.env, TETRABOARD_BOT_HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(`${cookie}\n`);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain(cookie);
    return { stdout, stderr, code };
  };
  try {
    const success = await auth("test-cookie");
    expect(success.code).toBe(0);
    expect(success.stdout).toContain("認証情報を保存しました");
    expect(await store.loadProfile()).toEqual({ cookie: "test-cookie", identity: ids[0] });
    expect((await stat(join(store.directory, "profile.json"))).mode & 0o777).toBe(0o600);

    accepted = false;
    const failure = await auth("replacement-cookie");
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(`${origin}では利用規約（2026-11-11）が未同意`);
    expect(await store.loadProfile()).toEqual({ cookie: "test-cookie", identity: ids[0] });
    expect(requests).toEqual([
      "GET /api/account/session",
      "GET /api/account/legal",
      "GET /api/account/session",
      "GET /api/account/legal",
    ]);
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
