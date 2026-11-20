import { legalDocuments, legalVersion } from "@tetraboard/protocol/privacy";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { request } from "./privacyFixtures";

for (const game of [
  "four-reversi",
  "four-shogi",
  "reversi",
  "shogi",
  "gomoku",
  "four-gomoku",
] as const) {
  test(`${game}: 未確認・旧版は参加を拒否し、確認済みゲストの名前は保持する`, async () => {
    const body = JSON.stringify({
      game,
      name: "公開するゲスト名",
      quickPlay: false,
      ...(["four-reversi", "four-shogi", "four-gomoku"].includes(game) ? { mode: "singles" } : {}),
    });
    for (const version of [undefined, "old"]) {
      const response = await request("/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(version ? { "X-Legal-Consent": version } : {}),
        },
        body,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "consent_required" });
    }
    const response = await request("/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Legal-Consent": legalVersion },
      body,
    });
    expect(response.status).toBe(201);
    const data = (await response.json()) as {
      room: { players: { name: string }[]; id: string };
      membership: { token: string };
    };
    expect(data.room.players[0].name).toBe("公開するゲスト名");
    expect(
      (
        await request(`/rooms/${data.room.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${data.membership.token}` },
        })
      ).status,
    ).toBe(204);
  });
}

test("ポリシーと規約は初回HTMLとHEADで未認証にも提供する", async () => {
  const assets = {
    fetch: async () =>
      new Response(
        '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>',
      ),
  } as unknown as Fetcher;
  for (const kind of ["privacy", "terms"] as const) {
    const response = await worker.fetch(
      new Request(`${origin}/${kind}`),
      { ...env, ASSETS: assets },
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${legalDocuments[kind].title} | TetraBoard</title>`);
    for (const [title, text] of legalDocuments[kind].sections) {
      expect(html).toContain(title);
      expect(html).toContain(text);
    }
    expect(html).toContain("support@tetraboard.net");
    expect(html).toContain(legalVersion);
    const head = await worker.fetch(
      new Request(`${origin}/${kind}`, { method: "HEAD" }),
      { ...env, ASSETS: assets },
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(await head.text()).toBe("");
  }
});

test("登録者の版別同意は本人とOriginを確認し、再確認まで参加を拒否する", async () => {
  const user = await accountFixture();
  await env.APP_DB.prepare("UPDATE legal_consents SET version='old' WHERE account_id=?")
    .bind(user.id)
    .run();
  expect((await request("/account/legal", { headers: { Cookie: user.cookie } })).status).toBe(200);
  expect(
    (
      await request("/account/legal", {
        method: "POST",
        headers: { ...user.headers, Origin: "https://other.test" },
        body: JSON.stringify({ version: legalVersion, accepted: true }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/account/legal", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ version: "old", accepted: true }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/account/legal", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ version: legalVersion, accepted: true }),
      })
    ).status,
  ).toBe(200);
  const consent = await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
    .bind(user.id)
    .first();
  expect(consent).toEqual({ version: legalVersion });
  expect(
    (
      await request("/auth/sign-in/social", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      })
    ).status,
  ).toBe(403);
});
