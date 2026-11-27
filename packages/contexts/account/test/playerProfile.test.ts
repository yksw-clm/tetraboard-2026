import { expect, test } from "bun:test";
import { readPlayerProfile, type PlayerProfilePorts, type PlayerProfileQuery } from "../src";
import { MemoryProfiles, policy, row, user, preset } from "./fixtures";
const target: PlayerProfileQuery = {
  source: "profile",
  profileId: user.publicProfileId!,
  game: "four-reversi",
};
const stats = {
  singles: { total: 10, first: 3, second: 2, third: 4, fourth: 1 },
  doubles: { total: 4, wins: 2, losses: 2, draws: 0 },
};
function ports() {
  const memory = new MemoryProfiles();
  const calls: string[] = [];
  const r: PlayerProfilePorts = {
    profiles: memory,
    policy,
    validProfile: () => true,
    source: async () => ({ accountId: user.id }),
    stats: async () => {
      calls.push("stats");
      return stats;
    },
    rating: async () => {
      calls.push("rating");
      return { timing: "current", status: "placement" };
    },
    shogiRating: async () => {
      calls.push("shogi");
      return undefined;
    },
    reversiRating: async () => {
      calls.push("reversi");
      return undefined;
    },
    badges: () => {
      calls.push("badges");
      return [{ id: "games", tier: 1, value: 10 }];
    },
  };
  return { r, memory, calls };
}
test("公開IDから現在のプロフィールを読み、旧応答では詳細とレートを追加しません", async () => {
  const { r, calls } = ports();
  expect(await readPlayerProfile(r, target)).toEqual({
    kind: "account",
    profileId: row.publicProfileId!,
    name: row.name,
    username: row.username,
    avatarUrl: `/api/avatars/${preset}`,
    game: "four-reversi",
    stats: { singles: { total: 10, first: 3 }, doubles: { total: 4, wins: 2 } },
  });
  expect(calls).toEqual(["stats"]);
});
test("追加指定があるときだけ詳細・統計・バッジ・レートを返します", async () => {
  const { r, calls } = ports();
  expect(
    await readPlayerProfile(r, {
      ...target,
      includeDetails: "1",
      includeStats: "1",
      includeBadges: "1",
      includeRating: "1",
    }),
  ).toMatchObject({
    profileMessage: "よろしく",
    favoriteGames: ["shogi", "gomoku"],
    stats,
    rating: { timing: "current", status: "placement" },
    badges: [{ id: "games", tier: 1, value: 10 }],
  });
  expect(calls).toEqual(["stats", "rating", "badges"]);
});
test("統合したゲストの公開IDも統合先の現在値を参照します", async () => {
  const { r, memory } = ports();
  memory.rows.set("former-guest", {
    ...row,
    id: "former-guest",
    publicProfileId: "former-profile",
  });
  memory.merges.set("former-guest", user.id);
  expect(await readPlayerProfile(r, { ...target, profileId: "former-profile" })).toMatchObject({
    name: user.name,
    profileId: user.publicProfileId,
  });
  expect(memory.reads).toEqual([[user.id]]);
});
test("ゲストの現在値には登録者の詳細やレートを追加しません", async () => {
  const { r, memory, calls } = ports();
  memory.rows.set(row.id, { ...row, isAnonymous: 1 });
  const result = await readPlayerProfile(r, { ...target, includeDetails: "1", includeRating: "1" });
  expect(result).toMatchObject({ kind: "account", isGuest: true });
  expect(result).not.toHaveProperty("profileMessage");
  expect(result).not.toHaveProperty("rating");
  expect(calls).toEqual(["stats"]);
});
test("公開IDの照会後にIDが変わったアカウントや退会したアカウントを返しません", async () => {
  for (const update of ["rename", "delete"]) {
    const { r, memory } = ports();
    const query: PlayerProfileQuery = {
      source: "username",
      username: row.username!,
      game: "four-reversi",
    };
    r.stats = async () => {
      if (update === "rename") memory.rows.set(row.id, { ...row, username: "new_username" });
      else memory.rows.delete(row.id);
      return stats;
    };
    expect(await readPlayerProfile(r, query)).toEqual({
      status: 404,
      message: "プロフィールを表示できません。",
    });
  }
});
test("未設定・退会・不正プロフィールでは統計を読みません", async () => {
  for (const kind of ["missing", "incomplete", "invalid"]) {
    const { r, memory, calls } = ports();
    if (kind === "missing") memory.rows.clear();
    if (kind === "incomplete") memory.rows.set(row.id, { ...row, profileCompleted: 0 });
    if (kind === "invalid") r.validProfile = () => false;
    expect(await readPlayerProfile(r, target)).toEqual({
      status: 404,
      message: "プロフィールを表示できません。",
    });
    expect(calls).toEqual([]);
  }
});
test("公開ID欠落と保存障害は成功応答に変えません", async () => {
  const { r, memory } = ports();
  memory.rows.set(row.id, { ...row, publicProfileId: null });
  r.source = async () => ({ accountId: user.id });
  await expect(
    readPlayerProfile(r, {
      source: "room",
      roomId: "ABC123",
      instanceId: "instance",
      playerId: "player",
      game: "shogi",
    }),
  ).rejects.toThrow("Public profile ID is missing");
  r.profiles.accountId = async () => {
    throw new Error("unavailable");
  };
  await expect(readPlayerProfile(r, target)).rejects.toThrow("unavailable");
});
test("CPU・過去ゲスト・退会・変更済みルームの応答を保ちます", async () => {
  const query: PlayerProfileQuery = {
    source: "match",
    matchId: "match",
    playerId: "player",
    game: "shogi",
    includeRating: "1",
  };
  const { r, calls } = ports();
  const cpu = {
    kind: "cpu" as const,
    level: 2 as const,
    rating: { timing: "reference" as const, status: "rated" as const, rating: 1500 },
  };
  r.source = async () => ({ accountId: null, appearance: cpu });
  expect(await readPlayerProfile(r, query)).toEqual(cpu);
  r.source = async () => ({
    accountId: null,
    appearance: { kind: "guest", name: "以前の名前", avatarUrl: null },
  });
  expect(await readPlayerProfile(r, query)).toEqual({
    kind: "guest",
    name: "以前の名前",
    avatarUrl: null,
  });
  r.source = async () => ({ accountId: user.id, retired: true });
  expect(await readPlayerProfile(r, query)).toEqual({
    status: 404,
    message: "退会したプレイヤーです。",
  });
  r.source = async () => ({ status: 410, message: "ルームが変更されています。" });
  expect(await readPlayerProfile(r, query)).toEqual({
    status: 410,
    message: "ルームが変更されています。",
  });
  expect(calls).toEqual([]);
});
