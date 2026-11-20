import { legalVersion } from "@tetraboard/protocol/privacy";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { digest } from "../src/crypto";
import { responseCookies } from "../src/adapters/account/authCookies";
import { accountFixture, origin } from "./accountFixtures";
import { privacyConcurrencyFixture, unrelatedDeletionFixture } from "./privacyConcurrencyFixture";
import { request, verified } from "./privacyFixtures";

test("退会最終確認は本人・有効な再認証・Origin・確認入力・在室と一回性を検証する", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const send = (cookie: string, originValue = origin, confirm = true) =>
    request("/account/deletion/confirm", {
      method: "POST",
      headers: { Origin: originValue, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
  expect((await send(user.cookie)).status).toBe(403);
  expect((await send(await verified(user, Date.now() - 1))).status).toBe(403);
  let cookie = await verified(user);
  expect((await send(cookie, "https://evil.test")).status).toBe(403);
  expect((await send(cookie, origin, false)).status).toBe(400);
  expect((await send(cookie.replace(user.cookie, other.cookie))).status).toBe(403);
  await env.APP_DB.prepare(
    "INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,created_at_ms) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(
      user.id,
      crypto.randomUUID(),
      "99881",
      crypto.randomUUID(),
      crypto.randomUUID(),
      "登録名",
      null,
      Date.now(),
    )
    .run();
  expect((await send(cookie)).status).toBe(409);
  await env.APP_DB.prepare("DELETE FROM account_room_seats WHERE account_id=?").bind(user.id).run();
  cookie = await verified(user);
  const response = await send(cookie);
  expect(response.status).toBe(202);
  const receipt = ((await response.json()) as { receipt: string }).receipt;
  expect((await send(cookie)).status).toBe(401);
  const status = await request("/account/deletion/status", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ receipt }),
  });
  expect(status.status).toBe(200);
  expect(
    await env.APP_DB.prepare("SELECT receipt_hash FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ receipt_hash: await digest(receipt) });
});

test("削除対象のflowは別人や期限切れで切り替わらず、取消でアカウントを残す", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const cookie = await verified(user),
    wrong = cookie.replace(user.cookie, other.cookie);
  expect(
    (
      await request("/account/deletion/reauth", {
        method: "POST",
        headers: { Origin: origin, Cookie: wrong },
      })
    ).status,
  ).toBe(409);
  expect(
    await (await request("/account/deletion/confirmation", { headers: { Cookie: wrong } })).json(),
  ).toMatchObject({ verified: false, changedAccount: true });
  expect(
    (
      await request("/account/deletion/cancel", {
        method: "POST",
        headers: { Origin: "https://evil.test", Cookie: wrong },
      })
    ).status,
  ).toBe(403);
  const canceled = await request("/account/deletion/cancel", {
    method: "POST",
    headers: { Origin: origin, Cookie: wrong },
  });
  expect(canceled.status).toBe(204);
  for (const id of [user.id, other.id])
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM deleted_accounts WHERE id=?").bind(id).first(),
    ).toBeNull();
  expect(
    (
      await request("/account/deletion/reauth", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).status,
  ).toBe(409);
});

test("同時に再認証を始めても1分5回を超えず、削除後のCookieはゲスト参加を妨げない", async () => {
  const expectUnrelatedDeletionUnchanged = await unrelatedDeletionFixture();
  const { db, accountFixture, request } = await privacyConcurrencyFixture();
  const user = await accountFixture();
  await db
    .prepare(
      "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    )
    .bind(crypto.randomUUID(), crypto.randomUUID(), "google", user.id, Date.now(), Date.now())
    .run();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("/account/deletion/reauth", {
        method: "POST",
        headers: { Origin: origin, Cookie: user.cookie },
      }),
    ),
  );
  expect(results.filter((r) => r.status === 200)).toHaveLength(5);
  expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  const second = await accountFixture(),
    cookie = await verified(second, undefined, db);
  const response = await request("/account/deletion/confirm", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  expect(response.status).toBe(202);
  const cleared = responseCookies(
    new Request(origin, { headers: { Cookie: cookie } }),
    response,
  ).get("Cookie")!;
  expect(cleared).toContain("tetraboard-2026.session_token=");
  expect(cleared).not.toContain(encodeURIComponent(second.token));
  const withoutEmpty = cleared
    .split("; ")
    .filter((v) => !v.endsWith("="))
    .join("; ");
  const guest = await request("/rooms", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: withoutEmpty,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
    },
    body: JSON.stringify({ name: "ゲスト", mode: "singles", quickPlay: false }),
  });
  expect(guest.status).toBe(201);
  await expectUnrelatedDeletionUnchanged();
});

test("再認証の取消を繰り返しても1分5回の制限をリセットできない", async () => {
  const user = await accountFixture();
  await env.APP_DB.prepare(
    "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), crypto.randomUUID(), "google", user.id, Date.now(), Date.now())
    .run();
  for (let i = 0; i < 6; i++) {
    const response = await request("/account/deletion/reauth", {
      method: "POST",
      headers: { Origin: origin, Cookie: user.cookie },
    });
    expect(response.status).toBe(i < 5 ? 200 : 429);
    if (i === 5) break;
    const cookie = responseCookies(
      new Request(origin, { headers: { Cookie: user.cookie } }),
      response,
    ).get("Cookie")!;
    expect(
      (
        await request("/account/deletion/cancel", {
          method: "POST",
          headers: { Origin: origin, Cookie: cookie },
        })
      ).status,
    ).toBe(204);
  }
});
