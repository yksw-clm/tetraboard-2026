import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ratedMatchmakingGameIds,
  ratingRankingContracts,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { ratedMatchmakingPolicy } from "../src/matchmaking/ratedMatchmaking";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { accountFixture } from "./accountFixtures";

const users: string[] = [];
const matches: string[] = [];
async function playerFixture() {
  const user = await accountFixture();
  users.push(user.id);
  return user;
}
afterEach(async () => {
  for (const id of matches.splice(0))
    await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id).run();
  for (const id of users.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM guest_account_merges WHERE guest_id=? OR account_id=?").bind(
        id,
        id,
      ),
      env.APP_DB.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=? OR target_id=?").bind(
        id,
        id,
      ),
      env.APP_DB.prepare("DELETE FROM session WHERE userId=?").bind(id),
      env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id),
    ]);
});
beforeEach(async () => {
  await env.APP_DB.batch(
    ratedMatchmakingGameIds.map((game) =>
      env.APP_DB.prepare(`DELETE FROM ${ratedMatchmakingPolicy(game).store.changesTable}`),
    ),
  );
});

async function seed(
  game: RatedMatchmakingGame,
  accountId: string,
  value: number,
  games = 5,
  humanGames = 0,
) {
  const id = crypto.randomUUID();
  matches.push(id);
  const four = game === "four-shogi" || game === "four-reversi";
  const table = ratedMatchmakingPolicy(game).store.changesTable;
  await env.APP_DB.prepare(
    "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,'singles',1,2,'{}')",
  )
    .bind(id, game)
    .run();
  if (four) {
    await env.APP_DB.prepare(
      `INSERT INTO ${table}(match_id,account_id,mu_before,sigma_before,mu_after,sigma_after,rated_games,human_games) VALUES (?,?,25,8,?,7,?,?)`,
    )
      .bind(id, accountId, 25 + (value - 1500) / 50, games, humanGames)
      .run();
  } else {
    await env.APP_DB.prepare(
      `INSERT INTO ${table}(match_id,account_id,rating_before,rating_after,rated_games,human_games) VALUES (?,?,1500,?,?,?)`,
    )
      .bind(id, accountId, value, games, humanGames)
      .run();
  }
}
async function rankings(game: RatedMatchmakingGame) {
  const contract = ratingRankingContracts[game];
  const response = await boundaryRequest(contract.path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return contract.response.parse(await response.json());
}

for (const game of ratedMatchmakingGameIds) {
  test(`${game}: 未認証で空一覧を取得でき、認定5局から最新レートだけを公開する`, async () => {
    expect((await rankings(game)).entries).toEqual([]);
    const player = await playerFixture();
    await seed(game, player.id, 1900, 4);
    expect((await rankings(game)).entries).toEqual([]);
    await seed(game, player.id, 1600.4, 5);
    expect((await rankings(game)).entries.map((row) => row.value)).toEqual([1600]);
    await seed(game, player.id, 1550.6, 6, 1);
    const { entries } = await rankings(game);
    expect(entries.map((row) => row.value)).toEqual([1551]);
    expect(entries[0]?.username).toBe(player.username);
    expect(entries[0]?.profileId).toBeTruthy();
    expect(JSON.stringify(entries)).not.toContain(player.id);
    expect(JSON.stringify(entries)).not.toContain("mu_after");
    for (const other of ratedMatchmakingGameIds.filter((other) => other !== game))
      expect((await rankings(other)).entries).toEqual([]);
  });

  test(`${game}: 丸め後の同順位・公開ID順・最大10人と最新プロフィール`, async () => {
    for (let index = 11; index >= 0; index--) {
      const player = await playerFixture();
      await env.APP_DB.prepare("UPDATE user SET username=?, name=? WHERE id=?")
        .bind(
          `r_${game.replaceAll("-", "")}_${String(index).padStart(2, "0")}`,
          "現在の名前",
          player.id,
        )
        .run();
      await seed(game, player.id, index < 2 ? 1700.1 + index * 0.2 : 1600.1 + index * 0.01);
    }
    const { entries } = await rankings(game);
    expect(entries.map((row) => row.username)).toEqual(
      Array.from(
        { length: 10 },
        (_, i) => `r_${game.replaceAll("-", "")}_${String(i).padStart(2, "0")}`,
      ),
    );
    expect(entries.map((row) => row.rank)).toEqual([1, 1, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(entries.every((row) => row.name === "現在の名前")).toBe(true);
  });

  test(`${game}: ゲスト・未設定・退会・統合済みのアカウントを除外する`, async () => {
    const player = await playerFixture();
    const guest = await playerFixture();
    const incomplete = await playerFixture();
    const deleted = await playerFixture();
    const merged = await playerFixture();
    for (const user of [player, guest, incomplete, deleted, merged])
      await seed(game, user.id, 1800);
    await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id IN (?,?)")
      .bind(guest.id, merged.id)
      .run();
    await env.APP_DB.prepare("UPDATE user SET profileCompleted=0 WHERE id=?")
      .bind(incomplete.id)
      .run();
    await env.APP_DB.prepare(
      "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,1,?)",
    )
      .bind(deleted.id, crypto.randomUUID())
      .run();
    const tokenHash = crypto.randomUUID();
    const session = await env.APP_DB.prepare("SELECT id FROM session WHERE userId=?")
      .bind(player.id)
      .first<{ id: string }>();
    await env.APP_DB.prepare(
      "INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES (?,?,9999999999999)",
    )
      .bind(tokenHash, merged.id)
      .run();
    await env.APP_DB.prepare(
      "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id) VALUES (?,?,?,'google',0,9999999999999,?,?)",
    )
      .bind(crypto.randomUUID(), merged.id, tokenHash, player.id, session!.id)
      .run();
    await env.APP_DB.prepare("INSERT INTO guest_account_merges VALUES (?,?,1)")
      .bind(merged.id, player.id)
      .run();
    // 統合済み除外を匿名フラグの条件とは独立に確認します。
    await env.APP_DB.prepare("UPDATE user SET isAnonymous=0 WHERE id=?").bind(merged.id).run();
    expect((await rankings(game)).entries.map((row) => row.username)).toEqual([player.username]);
  });
}

test("レート0・負値も表示でき、負の半整数も公開表示と同じ丸めになる", async () => {
  for (const game of ratedMatchmakingGameIds) {
    const zero = await playerFixture();
    const negative = await playerFixture();
    await seed(game, zero.id, 0);
    await seed(game, negative.id, -100.5);
    expect((await rankings(game)).entries.map((row) => row.value)).toEqual([0, -100]);
  }
});

test("D1取得失敗は空一覧にせず503を返し、非対応ゲームにAPIを追加しない", async () => {
  await env.APP_DB.exec("ALTER TABLE shogi_rating_changes RENAME TO shogi_rating_unavailable");
  try {
    const response = await boundaryRequest(ratingRankingContracts.shogi.path);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    await env.APP_DB.exec("ALTER TABLE shogi_rating_unavailable RENAME TO shogi_rating_changes");
  }
  expect((await boundaryRequest("/games/gomoku/rankings/rating")).status).toBe(404);
});
