import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { gameIds, type GameId } from "@tetraboard/protocol/games";
import {
  getMatchContract,
  getPublicMatchContract,
  getPlayerProfileContract,
} from "@tetraboard/protocol";
import {
  acceptMatchClaim,
  applyMatchClaims,
  readMatchClaimState,
  retryPendingMatchClaims,
} from "../src/accounts/matchClaims";
import { readStoredMatch, type DecodedMatch } from "../src/accounts/matchDataContracts";
import { readAccountStats } from "../src/accounts/statsRoutes";
import { readFormationStats } from "../src/accounts/formationStatsRoutes";
import { writeMatch } from "../src/rooms/matchStore";
import { advanceShogiMatchSave, type ShogiSaveProgress } from "../src/rooms/shogiMatchStore";
import { emptyFormationUsage } from "../src/rooms/shogiFormationUsage";
import { requestDeletion } from "../src/privacy/deletion";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord, fixtureRecord, matchRequest } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { standardShogiRecord, saveStandardShogiFixture } from "./standardShogiFixtures";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomoku from "../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomoku from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";

function fixture(game: GameId, cpu = false) {
  const fourShogi = humanShogiRecord(null);
  const shogi = standardShogiRecord(null);
  const snapshot =
    game === "four-shogi"
      ? fourShogi.record
      : game === "shogi"
        ? shogi.record
        : game === "four-reversi"
          ? humanFixtureRecord(crypto.randomUUID(), 1)
          : game === "four-gomoku"
            ? JSON.parse(fourGomoku.recordJson)
            : {
                ...(game === "reversi" ? reversi.detail : gomoku.detail),
                instanceId: crypto.randomUUID(),
              };
  const id = crypto.randomUUID();
  const record = readStoredMatch(
    JSON.stringify({
      ...snapshot,
      id,
      replay: { ...snapshot.replay, ...(snapshot.replay.id ? { id } : {}) },
      participants: snapshot.participants.map(
        (
          p: {
            id: string;
            name: string;
            kind: string;
            accountId?: string | null;
            avatarUrl?: string | null;
          },
          i: number,
        ) => {
          const { accountId: _account, avatarUrl: _avatar, ...player } = p;
          return cpu && i === 0
            ? { ...player, kind: "cpu", level: 1 }
            : { ...player, kind: "human", accountId: null };
        },
      ),
    }),
    game,
  );
  async function save() {
    if (record.game === "four-shogi")
      await saveShogiFixture({ record: record.record, events: fourShogi.events });
    else if (record.game === "shogi")
      await saveStandardShogiFixture({ record: record.record, events: shogi.events });
    else await writeMatch(env.APP_DB, record.record);
  }
  return { record, save };
}
function input(
  record: DecodedMatch,
  accountId: string,
  playerId = record.record.participants.at(-1)!.id,
) {
  return {
    matchId: record.record.id,
    roomId: record.record.roomId,
    instanceId: record.record.instanceId,
    playerId,
    accountId,
  };
}
async function storedJson(id: string) {
  return (await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(id)
    .first<{ record_json: string }>())!.record_json;
}

for (const game of gameIds)
  for (const cpu of [false, true]) {
    test(`${game}: ${cpu ? "CPU戦は棋譜のみ" : "対人戦は戦績も"}引き継ぎ、本人位置と公開プロフィールを統一する`, async () => {
      const user = await accountFixture();
      const item = fixture(game, cpu);
      await item.save();
      const before = await storedJson(item.record.record.id);
      const claim = input(item.record, user.id);
      const guestProfileQuery = new URLSearchParams({
        game,
        source: "match",
        matchId: claim.matchId,
        playerId: claim.playerId,
      });
      const beforeProfile = await matchRequest(`/player-profile?${guestProfileQuery}`);
      expect(getPlayerProfileContract.response.parse(await beforeProfile.json()).kind).toBe(
        "guest",
      );
      expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("applied");
      expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("applied");
      await item.save();
      expect(await storedJson(claim.matchId)).toBe(before);
      const stats = await readAccountStats(env.APP_DB, user.id, game);
      expect("singles" in stats ? stats.singles.total : stats.total).toBe(cpu ? 0 : 1);
      const own = await matchRequest(`/account/matches/${claim.matchId}`, {
        headers: { Cookie: user.cookie },
      });
      expect(own.status).toBe(200);
      const detail = getMatchContract.response.parse(await own.json()).match;
      expect(detail.selfPlayerId).toBe(claim.playerId);
      const publicResponse = await matchRequest(`/matches/${claim.matchId}`);
      expect(publicResponse.status).toBe(200);
      const publicDetail = getPublicMatchContract.response.parse(await publicResponse.json()).match;
      expect(publicDetail.participants.find((p) => p.id === claim.playerId)?.name).toBe("登録名");
      expect(JSON.stringify(publicDetail)).not.toContain(user.id);
      const currentProfile = await matchRequest(`/player-profile?${guestProfileQuery}`);
      expect(getPlayerProfileContract.response.parse(await currentProfile.json()).kind).toBe(
        "account",
      );
      await env.APP_DB.prepare("UPDATE user SET name='登録後の名前' WHERE id=?")
        .bind(user.id)
        .run();
      const updated = getPublicMatchContract.response.parse(
        await (await matchRequest(`/matches/${claim.matchId}`)).json(),
      ).match;
      expect(updated.participants.find((p) => p.id === claim.playerId)?.name).toBe("登録後の名前");
      const other = await accountFixture();
      expect(
        (
          await matchRequest(`/account/matches/${claim.matchId}`, {
            headers: { Cookie: other.cookie },
          })
        ).status,
      ).toBe(404);
      const history = await env.APP_DB.prepare(
        "SELECT COUNT(*) AS n FROM account_match_history WHERE account_id=? AND match_id=?",
      )
        .bind(user.id, claim.matchId)
        .first<{ n: number }>();
      expect(history?.n).toBe(1);
    });
  }

test("保存待ちで受付後、期限や部屋の状態に依存せず保存完了から反映する", async () => {
  const user = await accountFixture();
  const item = fixture("four-reversi");
  const claim = input(item.record, user.id);
  expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("pending");
  expect(await readMatchClaimState(env.APP_DB, claim.matchId, claim.playerId, user.id)).toBe(
    "pending",
  );
  expect((await readAccountStats(env.APP_DB, user.id, "four-reversi")).singles.total).toBe(0);
  await env.APP_DB.prepare(
    "UPDATE match_participant_accounts SET accepted_at_ms=0 WHERE match_id=?",
  )
    .bind(claim.matchId)
    .run();
  await item.save();
  expect(await readMatchClaimState(env.APP_DB, claim.matchId, claim.playerId, user.id)).toBe(
    "applied",
  );
});

test("別アカウントへの再取得・同一アカウントの別席・CPU・不一致な本人参照を拒否する", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  const item = fixture("four-reversi", true);
  await item.save();
  const claim = input(item.record, user.id);
  await acceptMatchClaim(env.APP_DB, claim);
  for (const invalid of [
    { ...claim, accountId: other.id },
    { ...claim, playerId: item.record.record.participants[1].id },
    { ...claim, playerId: item.record.record.participants[0].id },
    { ...claim, playerId: crypto.randomUUID() },
    { ...claim, instanceId: crypto.randomUUID() },
  ])
    await expect(acceptMatchClaim(env.APP_DB, invalid)).rejects.toThrow();
  const original = fixtureRecord(user.id, 1);
  await writeMatch(env.APP_DB, original);
  await expect(
    acceptMatchClaim(env.APP_DB, {
      matchId: original.id,
      playerId: original.participants[1].id,
      accountId: user.id,
      roomId: original.roomId,
      instanceId: original.instanceId,
    }),
  ).rejects.toThrow("conflict");
});

test("同時に異なる席を同じアカウントへ引き継いでも1席だけが確定する", async () => {
  const user = await accountFixture();
  const item = fixture("four-reversi");
  await item.save();
  const results = await Promise.allSettled(
    item.record.record.participants
      .slice(1, 3)
      .map((p) => acceptMatchClaim(env.APP_DB, input(item.record, user.id, p.id))),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await readAccountStats(env.APP_DB, user.id, "four-reversi")).singles.total).toBe(1);
});

test("保存後に不適格と分かった受付は終端化し、別人の引継ぎと棋譜保存を妨げない", async () => {
  const native = await accountFixture();
  const guest = await accountFixture();
  const record = humanFixtureRecord(native.id, 1);
  const decoded = readStoredMatch(JSON.stringify(record), "four-reversi");
  const invalid = input(decoded, native.id, record.participants[1].id);
  const valid = input(decoded, guest.id, record.participants[2].id);
  expect(await acceptMatchClaim(env.APP_DB, invalid)).toBe("pending");
  expect(await acceptMatchClaim(env.APP_DB, valid)).toBe("pending");
  await writeMatch(env.APP_DB, record);
  expect(await readMatchClaimState(env.APP_DB, record.id, invalid.playerId, native.id)).toBe(
    "rejected",
  );
  expect(await readMatchClaimState(env.APP_DB, record.id, valid.playerId, guest.id)).toBe(
    "applied",
  );
  expect((await readAccountStats(env.APP_DB, guest.id, "four-reversi")).singles.total).toBe(1);
  const other = await accountFixture();
  await expect(acceptMatchClaim(env.APP_DB, { ...invalid, accountId: other.id })).rejects.toThrow(
    "conflict",
  );
  expect(await requestDeletion(env, native.id, crypto.randomUUID())).toBe(true);
  const after = readStoredMatch(await storedJson(record.id), "four-reversi");
  expect(after.record.participants[1]).toMatchObject({
    name: record.participants[1].name,
    accountId: null,
  });
  expect(after.record.participants[1]).not.toHaveProperty("retired");
});

test("登録の確定フローとセッションがない受付ガードでは紐付けを作らない", async () => {
  const user = await accountFixture();
  const item = fixture("reversi");
  await item.save();
  const claim = input(item.record, user.id);
  await expect(
    acceptMatchClaim(env.APP_DB, claim, {
      registrationId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("conflict");
  expect(await readMatchClaimState(env.APP_DB, claim.matchId, claim.playerId, user.id)).toBeNull();
});

test("本人索引の障害で一部だけ反映せず、独立した再試行で復旧する", async () => {
  const user = await accountFixture();
  const item = fixture("four-reversi");
  await item.save();
  const claim = input(item.record, user.id);
  await env.APP_DB.exec(
    `CREATE TRIGGER fail_claim_history BEFORE INSERT ON account_match_history WHEN NEW.account_id='${user.id}' BEGIN SELECT RAISE(ABORT,'temporary failure'); END`,
  );
  try {
    expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("pending");
    expect((await readAccountStats(env.APP_DB, user.id, "four-reversi")).singles.total).toBe(0);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_claim_history");
  }
  await retryPendingMatchClaims(env.APP_DB, claim.roomId);
  expect(await readMatchClaimState(env.APP_DB, claim.matchId, claim.playerId, user.id)).toBe(
    "applied",
  );
});

test("引き継いだ対局でバッジを獲得し、再送で通知を増やさない", async () => {
  const user = await accountFixture();
  for (let i = 1; i <= 4; i++) await writeMatch(env.APP_DB, humanFixtureRecord(user.id, i));
  const item = fixture("four-reversi");
  await item.save();
  const claim = input(item.record, user.id);
  await env.APP_DB.exec(
    `CREATE TRIGGER fail_claim_badge BEFORE INSERT ON account_badge_notifications WHEN NEW.account_id='${user.id}' BEGIN SELECT RAISE(ABORT,'temporary failure'); END`,
  );
  try {
    expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("pending");
    expect((await readAccountStats(env.APP_DB, user.id, "four-reversi")).singles.total).toBe(4);
    expect(
      (
        await env.APP_DB.prepare("SELECT 1 FROM account_badge_awards WHERE account_id=?")
          .bind(user.id)
          .all()
      ).results,
    ).toHaveLength(0);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER fail_claim_badge");
  }
  await acceptMatchClaim(env.APP_DB, claim);
  await applyMatchClaims(env.APP_DB, claim.matchId);
  const award = await env.APP_DB.prepare(
    "SELECT tier,match_id FROM account_badge_awards WHERE account_id=? AND badge_id='games'",
  )
    .bind(user.id)
    .all();
  expect(award.results).toEqual([{ tier: 1, match_id: claim.matchId }]);
  const notices = await env.APP_DB.prepare(
    "SELECT COUNT(*) AS n FROM account_badge_notifications WHERE account_id=? AND match_id=?",
  )
    .bind(user.id, claim.matchId)
    .first<{ n: number }>();
  expect(notices?.n).toBe(1);
});

test("既存の四人将棋の成立履歴を本人の陣営から集計する", async () => {
  const user = await accountFixture();
  const item = humanShogiRecord(null, "west");
  const usage = emptyFormationUsage();
  usage.bySide.west = ["tenshukaku"];
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceShogiMatchSave(
      env.APP_DB,
      item.record,
      progress,
      (cursor) => item.events.slice(cursor, cursor + 100),
      usage,
    );
  const record = readStoredMatch(JSON.stringify(item.record), "four-shogi");
  await acceptMatchClaim(
    env.APP_DB,
    input(record, user.id, item.record.participants.find((p) => p.side === "west")!.id),
  );
  const stats = await readFormationStats(env.APP_DB, user.id);
  expect(stats.find((s) => s.id === "tenshukaku")).toMatchObject({ total: 1 });
});

for (const game of gameIds)
  for (const savedFirst of [true, false])
    test(`${game}: 退会で元ゲスト名を消し、${savedFirst ? "保存済み" : "保存待ち"}と再登録から復活させない`, async () => {
      const user = await accountFixture();
      const item = fixture(game);
      const claim = input(item.record, user.id);
      if (savedFirst) await item.save();
      await acceptMatchClaim(env.APP_DB, claim);
      expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);
      await item.save();
      const raw = readStoredMatch(await storedJson(claim.matchId), game);
      expect(raw.record.participants.find((p) => p.id === claim.playerId)).toMatchObject({
        name: "退会したプレイヤー",
        accountId: null,
        retired: true,
      });
      const response = await matchRequest(`/matches/${claim.matchId}`);
      expect(response.status).toBe(200);
      expect(
        getPublicMatchContract.response
          .parse(await response.json())
          .match.participants.find((p) => p.id === claim.playerId)?.name,
      ).toBe("退会したプレイヤー");
      const fresh = await accountFixture();
      await expect(acceptMatchClaim(env.APP_DB, { ...claim, accountId: fresh.id })).rejects.toThrow(
        "retired",
      );
      await expect(acceptMatchClaim(env.APP_DB, claim)).rejects.toThrow("retired");
      expect(await readMatchClaimState(env.APP_DB, claim.matchId, claim.playerId, user.id)).toBe(
        "retired",
      );
      // 同じ参加者IDでも引き継がなかった別の局はゲストのまま残します。
      const unrelated = fixture("four-reversi");
      unrelated.record.record.participants.at(-1)!.id = claim.playerId;
      await unrelated.save();
      const untouched = readStoredMatch(
        await storedJson(unrelated.record.record.id),
        "four-reversi",
      );
      expect(untouched.record.participants.at(-1)?.name).not.toBe("退会したプレイヤー");
    });

test("将棋の棋譜転送途中は反映せず、途中退会後のmanifest再送でも元ゲスト名を復活させない", async () => {
  const user = await accountFixture();
  const item = humanShogiRecord(null);
  let progress = await advanceShogiMatchSave(
    env.APP_DB,
    item.record,
    { phase: "upload", cursor: 0 },
    (cursor) => item.events.slice(cursor, cursor + 100),
  );
  expect(progress?.phase).toBe("verify");
  const decoded = readStoredMatch(JSON.stringify(item.record), "four-shogi");
  const claim = input(decoded, user.id);
  expect(await acceptMatchClaim(env.APP_DB, claim)).toBe("pending");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_match_history WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();
  await requestDeletion(env, user.id, crypto.randomUUID());
  while (progress)
    progress = await advanceShogiMatchSave(env.APP_DB, item.record, progress, (cursor) =>
      item.events.slice(cursor, cursor + 100),
    );
  const archived = readStoredMatch(await storedJson(claim.matchId), "four-shogi");
  expect(archived.record.participants.find((p) => p.id === claim.playerId)?.name).toBe(
    "退会したプレイヤー",
  );
});
