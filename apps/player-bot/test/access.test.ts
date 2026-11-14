import { test, expect } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { Api, cookieValue } from "../src/api";
import { Store } from "../src/store";
import { ids } from "./fixtures";

test("セッション更新Cookieを保存し、期限切れや未同意のHTTP200を成功と扱わない", async () => {
  let expired = false,
    accepted = true;
  const saved: string[] = [];
  const api = new Api(
    "https://example.com",
    { cookie: "old", identity: ids[0] },
    async (p) => {
      saved.push(p.cookie);
    },
    (async (input, init) => {
      if (String(input).endsWith("/session"))
        return Response.json(
          {
            user: expired
              ? null
              : {
                  profileId: ids[0],
                  username: "bot1",
                  name: "BOT-1",
                  avatarUrl: null,
                  profileCompleted: true,
                },
          },
          {
            headers: {
              "Set-Cookie":
                "__Secure-tetraboard-2026.session_token=renewed; HttpOnly; Secure; Path=/",
            },
          },
        );
      expect(new Headers(init?.headers).get("Cookie")).toBe(
        "__Secure-tetraboard-2026.session_token=renewed",
      );
      return Response.json({ accepted, version: legalVersion });
    }) as typeof fetch,
  );
  expect(await api.checkAccess()).toBe(ids[0]);
  expect(saved).toEqual(["renewed"]);
  accepted = false;
  await expect(api.checkAccess()).rejects.toThrow("利用規約");
  expired = true;
  await expect(api.checkAccess()).rejects.toThrow("Cookieを再取り込み");
});

test("Cookieを別origin・リダイレクトへ渡さず、レスポンス本文の認証値をエラーへ含めない", async () => {
  let calls = 0;
  const api = new Api(
    "https://example.com",
    { cookie: "secret", identity: ids[0] },
    async () => {},
    (async (_url, init) => {
      calls++;
      expect(init?.redirect).toBe("error");
      return Response.json(
        { message: "private-token", error: "private_session_credential" },
        { status: 403 },
      );
    }) as typeof fetch,
  );
  await expect(
    api.request("https://other.example/api/account/session", z.unknown()),
  ).rejects.toThrow("接続先");
  await expect(api.request("/api/account/session", z.unknown())).rejects.toThrow(
    "API 403: request_failed",
  );
  expect(calls).toBe(1);
  expect(() => cookieValue("secret\r\nOrigin: attacker")).toThrow();
});

test("プロフィールと復帰資格を環境別に保護し、同じBOTの二重起動を拒否する", async () => {
  const home = await mkdtemp(join(tmpdir(), "tb37-store-"));
  const store = new Store("https://example.com", "bot1", home);
  const other = new Store("https://development.example.com", "bot1", home);
  try {
    await store.saveProfile({ cookie: "secret", identity: ids[0] });
    expect(await other.loadProfile()).toBeNull();
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.directory, "profile.json"))).mode & 0o777).toBe(0o600);
    const release = await store.lock();
    await expect(store.lock()).rejects.toThrow("別のプロセス");
    await release();
    await writeFile(join(store.directory, "run.lock"), "2147483647", { mode: 0o600 });
    const releaseStale = await store.lock();
    await releaseStale();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("壊れた成功レスポンスに含まれる資格を例外メッセージへ出さない", async () => {
  const api = new Api(
    "https://example.com",
    { cookie: "secret", identity: ids[0] },
    async () => {},
    async () => new Response("private-session-credential", { status: 200 }),
  );
  await expect(api.request("/api/account/session", z.unknown())).rejects.toThrow(
    "API 0: incompatible_response",
  );
});
