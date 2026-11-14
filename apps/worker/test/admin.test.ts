import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import type { AdminEnv } from "../src/admin/auth";
const context = { waitUntil() {} } as unknown as ExecutionContext;
const fetchWith = (bindings: AdminEnv, path: string, init?: RequestInit) =>
  worker.fetch(new Request(origin + path, init), bindings, context);
test("管理API・HTMLは本人限定で、通報用トークンを流用せず、障害と未認証を区別する", async () => {
  const owner = await accountFixture();
  const other = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  for (const path of ["/api/admin/session"]) {
    expect((await fetchWith(bindings, path)).status).toBe(401);
    expect((await fetchWith(bindings, path, { headers: { Cookie: other.cookie } })).status).toBe(
      403,
    );
    expect(
      (
        await fetchWith(bindings, path, {
          headers: { Authorization: "Bearer test-moderator-token" },
        })
      ).status,
    ).toBe(401);
    const allowed = await fetchWith(bindings, path, { headers: { Cookie: owner.cookie } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
  }
  const assets = {
    fetch: async (request: Request) => new Response(new URL(request.url).pathname),
  } as Fetcher;
  const deployed = { ...bindings, ASSETS: assets };
  for (const path of [
    "/%61dmin/index.html",
    "/admin%2Fassets/example.js",
    "//admin/index.html",
    "/unused%2F..%2Fadmin/index.html",
  ])
    expect((await fetchWith(deployed, path)).status).toBe(302);
  const denied = await fetchWith(deployed, "/admin/kpi");
  expect(denied.status).toBe(302);
  expect(denied.headers.get("Location")).toBe(`${origin}/login?destination=admin`);
  expect((await fetchWith(deployed, "/admin", { headers: { Cookie: other.cookie } })).status).toBe(
    403,
  );
  expect(
    await (await fetchWith(deployed, "/admin/kpi", { headers: { Cookie: owner.cookie } })).text(),
  ).toBe("/admin/index.html");
  expect(
    await (
      await fetchWith(deployed, "/admin/assets/example.js", { headers: { Cookie: owner.cookie } })
    ).text(),
  ).toBe("/admin/assets/example.js");
  const unconfigured = { ...env };
  Reflect.deleteProperty(unconfigured, "ADMIN_ACCOUNT_IDS");
  expect((await fetchWith(unconfigured, "/api/admin/session")).status).toBe(503);
  const failedDb = {
    prepare() {
      throw new Error("unavailable");
    },
  } as unknown as D1Database;
  expect(
    (
      await fetchWith({ ...bindings, APP_DB: failedDb }, "/api/admin/session", {
        headers: { Cookie: owner.cookie },
      })
    ).status,
  ).toBe(503);
});

test("指定した2つの本人アカウントだけを許可し、管理者配列の欠落や不正を拒否する", async () => {
  const owners = [await accountFixture(), await accountFixture()];
  const other = await accountFixture();
  const bindings = {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify([owners[0].id, owners[1].id, owners[0].id]),
    ASSETS: {
      fetch: async (request: Request) => new Response(new URL(request.url).pathname),
    } as Fetcher,
  };
  for (const owner of owners)
    for (const path of ["/api/admin/session", "/admin/kpi"])
      expect((await fetchWith(bindings, path, { headers: { Cookie: owner.cookie } })).status).toBe(
        200,
      );
  for (const path of ["/api/admin/session", "/admin/kpi"])
    expect((await fetchWith(bindings, path, { headers: { Cookie: other.cookie } })).status).toBe(
      403,
    );
  for (const value of ["", "[]", "[1]", '[""]', "{", JSON.stringify([owners[0].id, " "])])
    expect(
      (
        await fetchWith({ ...bindings, ADMIN_ACCOUNT_IDS: value }, "/api/admin/session", {
          headers: { Cookie: other.cookie },
        })
      ).status,
    ).toBe(503);
});
