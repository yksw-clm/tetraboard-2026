import { env } from "cloudflare:workers";
import { getPlayerProfileContract } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";

function request(query: Record<string, string>) {
  const search = new URLSearchParams({
    game: "four-shogi",
    includeStats: "1",
    includeRating: "1",
    ...query,
  });
  return worker.fetch(
    new Request(`${origin}/api/player-profile?${search}`),
    env,
    {} as ExecutionContext,
  );
}

test("公開IDを正規化し、従来の公開UUID参照と同じ登録者プロフィールを返す", async () => {
  const account = await accountFixture();
  await env.APP_DB.prepare("UPDATE user SET username=? WHERE id=?")
    .bind("Current_ID", account.id)
    .run();
  const response = await request({ source: "username", username: "@CURRENT_ID" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = getPlayerProfileContract.response.parse(await response.json());
  expect(result).toMatchObject({ kind: "account", username: "current_id", name: "登録名" });
  if (result.kind !== "account") throw new Error("Expected public account profile");
  expect(JSON.stringify(result)).not.toContain(account.id);
  const legacy = await request({ source: "profile", profileId: result.profileId });
  expect(await legacy.json()).toEqual(result);
  expect((await request({ source: "username", username: account.username })).status).toBe(404);
  expect(
    (await request({ source: "username", username: "current_id", profileId: result.profileId }))
      .status,
  ).toBe(400);
});

test("不正なID、非公開、ゲスト、退会受付済みのアカウントを公開IDで取得できない", async () => {
  const incomplete = await accountFixture();
  const invalid = await accountFixture();
  const guest = await accountFixture();
  const deleted = await accountFixture();
  await env.APP_DB.batch([
    env.APP_DB.prepare("UPDATE user SET profileCompleted=0 WHERE id=?").bind(incomplete.id),
    env.APP_DB.prepare("UPDATE user SET name='' WHERE id=?").bind(invalid.id),
    env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id),
    env.APP_DB.prepare(
      "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,1,?)",
    ).bind(deleted.id, crypto.randomUUID()),
  ]);
  const malformed = await request({ source: "username", username: "@@bad" });
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get("Cache-Control")).toBe("no-store");
  for (const username of [
    "unknown_player",
    incomplete.username,
    invalid.username,
    guest.username,
    deleted.username,
  ]) {
    const response = await request({ source: "username", username });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ message: "プロフィールを表示できません。" });
  }
});
