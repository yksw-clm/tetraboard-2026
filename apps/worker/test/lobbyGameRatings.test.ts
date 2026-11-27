import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { lobbyGameRatingsSchema } from "@tetraboard/protocol/general-lobby";
import {
  getPlayerGameRatingsContract,
  ratedMatchmakingGameIds,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import worker from "../src/worker";
import { ratedMatchmakingPolicy } from "../src/adapters/matchmaking/ratedMatchmaking";
import { accountFixture, origin } from "./accountFixtures";

const request = (headers?: HeadersInit) =>
  worker.fetch(
    new Request(`${origin}/api/lobby/game-ratings`, { headers }),
    {
      ...env,
      AI_SERVICE_URL: "https://ai.example.test",
      AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
      AI_SHOGI_ENABLED: "true",
      SHOGI_MATCHMAKING_ENABLED: "true",
      FOUR_SHOGI_MATCHMAKING_ENABLED: "true",
      REVERSI_MATCHMAKING_ENABLED: "false",
      MATCHMAKING_ENABLED: "true",
    },
    {} as ExecutionContext,
  );

const publicRatings = (profileId: string, headers?: HeadersInit) =>
  worker.fetch(
    new Request(`${origin}/api/players/${profileId}/game-ratings`, { headers }),
    { ...env, REVERSI_MATCHMAKING_ENABLED: "false" },
    {} as ExecutionContext,
  );

async function player() {
  const account = await accountFixture();
  const profileId = await env.APP_DB.prepare("SELECT publicProfileId FROM user WHERE id=?")
    .bind(account.id)
    .first<string>("publicProfileId");
  return { ...account, profileId: profileId! };
}

async function seedRating(
  accountId: string,
  game: RatedMatchmakingGame,
  games: number,
  value: number,
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const fourPlayer = game === "four-shogi" || game === "four-reversi";
  const table = ratedMatchmakingPolicy(game).store.changesTable;
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, '{}')").bind(
      id,
      game,
      fourPlayer ? "singles" : "standard",
      now,
      now,
    ),
    fourPlayer
      ? env.APP_DB.prepare(`INSERT INTO ${table} VALUES ('${game}',?, ?, 25, 8, ?, 8, ?, 0)`).bind(
          id,
          accountId,
          25 + (value - 1500) / 50,
          games,
        )
      : env.APP_DB.prepare(`INSERT INTO ${table} VALUES ('${game}',?, ?, 1500, ?, ?, 0)`).bind(
          id,
          accountId,
          value,
          games,
        ),
  ]);
}

test("未ログインとゲストには環境の受付状態を返し、本人レートを返さない", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = lobbyGameRatingsSchema.parse(await response.json());
  expect(result.viewer).toBeNull();
  expect(Object.keys(result.games).sort()).toEqual([...ratedMatchmakingGameIds].sort());
  expect(result.games.shogi.enabled).toBe(true);
  expect(result.games.reversi.enabled).toBe(false);
  expect(result.games["four-shogi"].enabled).toBe(true);
  expect(result.games["four-reversi"].enabled).toBe(true);
  expect(Object.values(result.games).every(({ summary }) => summary === null)).toBe(true);
  const guest = await worker.fetch(
    new Request(`${origin}/api/account/guest`, {
      method: "POST",
      headers: { Origin: origin, "X-Legal-Consent": legalVersion },
      body: JSON.stringify({ name: "レート確認ゲスト" }),
    }),
    env,
    {} as ExecutionContext,
  );
  expect(guest.status).toBe(201);
  const cookie = guest.headers
    .getSetCookie()
    .find((value) => value.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  expect(await (await request({ Cookie: cookie })).json()).toEqual(result);
});

test("本人の全ゲームの認定進捗と整数レートをまとめ、受付停止中も保存済みレートを返す", async () => {
  const account = await accountFixture();
  await seedRating(account.id, "shogi", 5, 1541.8);
  await seedRating(account.id, "reversi", 7, 1723);
  await seedRating(account.id, "four-reversi", 2, 1800);
  await seedRating(account.id, "four-shogi", 6, 1610);
  const result = await (await request(account.headers)).json();
  expect(result).toMatchObject({
    viewer: { username: account.username },
    games: {
      shogi: { enabled: true, summary: { status: "rated", rating: 1542 } },
      reversi: { enabled: false, summary: { status: "rated", rating: 1723 } },
      "four-reversi": { enabled: true, summary: { status: "placement", games: 2 } },
      "four-shogi": { enabled: true, summary: { status: "rated", rating: 1610 } },
    },
  });
  const encoded = JSON.stringify(result);
  for (const hidden of [account.id, '"rank"', '"mu"', '"sigma"'])
    expect(encoded).not.toContain(hidden);
  const other = await accountFixture();
  const empty = lobbyGameRatingsSchema.parse(await (await request(other.headers)).json());
  expect(
    Object.values(empty.games).every(
      ({ summary }) => summary?.status === "placement" && summary.games === 0,
    ),
  ).toBe(true);
});

test("1ゲームの取得に失敗しても受付状態と他ゲームのレートを返す", async () => {
  const account = await accountFixture();
  await seedRating(account.id, "shogi", 5, 1542);
  const failure = vi
    .spyOn(ratedMatchmakingPolicy("reversi"), "readSummary")
    .mockRejectedValueOnce(new Error("test rating read failure"));
  try {
    const result = lobbyGameRatingsSchema.parse(await (await request(account.headers)).json());
    expect(result.games.reversi).toEqual({ enabled: false, summary: { status: "error" } });
    expect(result.games.shogi.summary).toEqual({ status: "rated", rating: 1542 });
  } finally {
    failure.mockRestore();
  }
});

test("公開レートはログインに依らず対象UUIDの4ゲームと保存済み認定進捗だけを返す", async () => {
  const target = await player();
  const viewer = await player();
  await seedRating(target.id, "reversi", 5, 1730);
  await seedRating(target.id, "four-shogi", 3, 1800);
  await seedRating(viewer.id, "reversi", 6, 1420);

  const response = await publicRatings(target.profileId, viewer.headers);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(getPlayerGameRatingsContract.response.parse(body)).toEqual({
    profileId: target.profileId,
    games: {
      "four-reversi": { status: "placement", games: 0 },
      "four-shogi": { status: "placement", games: 3 },
      reversi: { status: "rated", rating: 1730 },
      shogi: { status: "placement", games: 0 },
    },
  });
  expect(await (await publicRatings(target.profileId)).json()).toEqual(body);
  expect((await publicRatings(target.id)).status).toBe(404);
  expect((await publicRatings("unknown")).status).toBe(400);
});

test("公開レートはゲストを除外し、統合された公開参照は統合先のレートを返す", async () => {
  const guest = await player();
  const registered = await player();
  await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  await seedRating(guest.id, "shogi", 5, 1800);
  await seedRating(registered.id, "shogi", 5, 1580);
  expect(await (await publicRatings(guest.profileId)).json()).toEqual({
    profileId: guest.profileId,
    games: null,
  });
  await env.APP_DB.prepare("INSERT INTO guest_account_merges VALUES (?, ?, 1)")
    .bind(guest.id, registered.id)
    .run();
  expect(await (await publicRatings(guest.profileId)).json()).toMatchObject({
    profileId: registered.profileId,
    games: { shogi: { status: "rated", rating: 1580 } },
  });
});

test("公開レートはゲーム別の取得失敗を返し、読取中に退会した場合は公開しない", async () => {
  const target = await player();
  const policy = ratedMatchmakingPolicy("reversi");
  const readSummary = policy.readSummary;
  const failure = vi.spyOn(policy, "readSummary").mockRejectedValueOnce(new Error("test failure"));
  try {
    expect(await (await publicRatings(target.profileId)).json()).toMatchObject({
      games: { reversi: { status: "error" }, shogi: { status: "placement", games: 0 } },
    });
    failure.mockImplementationOnce(async (db, id) => {
      const result = await readSummary(db, id);
      await db
        .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,1,?)")
        .bind(id, crypto.randomUUID())
        .run();
      return result;
    });
    const response = await publicRatings(target.profileId);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("games");
  } finally {
    failure.mockRestore();
  }
});
