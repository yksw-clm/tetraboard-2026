import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { getPlayerProfileContract, listPlayerMatchesContract } from "@tetraboard/protocol";
import worker from "../src/worker";
import { acceptMatchClaim } from "../src/flows/matchSave/claims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import {
  guestMatchAccountTransferStatements,
  guestReplayTransferStatements,
} from "../src/adapters/record/guestMergeWrites";
import { accountFixture, origin } from "./accountFixtures";
import { fixtureRecord, humanFixtureRecord } from "./matchFixtures";
import { shogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { seedStoredMatches } from "./storedMatchFixtures";

const { PUBLIC_MATCH_TEST_DB: db, TEST_MIGRATIONS } = env as typeof env & {
  PUBLIC_MATCH_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const bindings = { ...env, APP_DB: db };
const matchIds: string[] = [];
const request = (path: string, headers?: HeadersInit, database = db) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, { headers }),
    { ...bindings, APP_DB: database },
    {} as ExecutionContext,
  );

beforeAll(async () => {
  await applyD1Migrations(db, TEST_MIGRATIONS);
});

afterEach(async () => {
  const ids = matchIds.splice(0);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.batch(
    [
      ["account_match_history", "match_id"],
      ["match_participant_accounts", "match_id"],
      ["match_event_chunks", "match_id"],
      ["matches", "id"],
      ["match_uploads", "id"],
    ].map(([table, column]) =>
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).bind(...ids),
    ),
  );
});

function track<T extends { id: string }>(record: T) {
  matchIds.push(record.id);
  return record;
}

async function player(completed = true) {
  const fixture = await accountFixture(completed, crypto.randomUUID(), db);
  const profileId =
    (await db
      .prepare("SELECT publicProfileId FROM user WHERE id=?")
      .bind(fixture.id)
      .first<string>("publicProfileId")) ?? crypto.randomUUID();
  if (!completed) {
    await db
      .prepare("UPDATE user SET publicProfileId=? WHERE id=?")
      .bind(profileId, fixture.id)
      .run();
  }
  return { ...fixture, profileId };
}

const singles = "game=four-reversi&mode=singles";
const listPath = (id: string, query = singles) => `/players/${id}/matches?${query}`;
const profilePath = (id: string) =>
  `/player-profile?source=profile&profileId=${id}&game=four-reversi`;

async function list(id: string, query?: string) {
  const response = await request(listPath(id, query));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Set-Cookie")).toBeNull();
  return listPlayerMatchesContract.response.parse(await response.json()).matches;
}

function afterHistoryRead(onRead: () => Promise<void>) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM account_match_history h")) return statement;
          return {
            bind(...values: unknown[]) {
              return {
                async all<T>() {
                  const result = await statement.bind(...values).all<T>();
                  await onRead();
                  return result;
                },
              };
            },
          };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("参加者・ゲーム・モードで絞ってから日時とUUIDの降順で20局を返す", async () => {
  const owner = await player();
  const namesake = await player();
  const records = Array.from({ length: 22 }, (_, index) => {
    const record = track(fixtureRecord(owner.id, index + 1));
    if (index === 0) {
      record.startedAtMs += 60_000;
      record.endedAtMs += 60_000;
    }
    return record;
  });
  const newer = Array.from({ length: 21 }, (_, index) => {
    const record = track(fixtureRecord(namesake.id, index + 1));
    record.startedAtMs += 120_000;
    record.endedAtMs += 120_000;
    return record;
  });
  const doubles = track(fixtureRecord(owner.id, 30, "doubles"));
  const shogi = shogiRecord(owner.id, "south", "singles");
  track(shogi.record);
  const uploading = shogiRecord(owner.id);
  track(uploading.record);
  await seedStoredMatches(
    db,
    [...records, ...newer, doubles].map((record) => ({ record })),
  );
  await saveShogiFixture(shogi, db);
  await db
    .prepare("INSERT INTO match_uploads VALUES (?, ?, ?, 1)")
    .bind(uploading.record.id, JSON.stringify(uploading.record), uploading.events.length)
    .run();

  const matches = await list(owner.profileId);
  expect(matches.map((match) => match.id)).toEqual([
    records[0]!.id,
    ...records
      .slice(3)
      .reverse()
      .map((record) => record.id),
  ]);
  expect(matches[0]).toMatchObject({ matchKind: "normal", moveCount: 0 });
  expect(matches[0]!.participants.some((participant) => participant.kind === "cpu")).toBe(true);
  expect((await list(owner.profileId, "game=four-reversi&mode=doubles")).map((m) => m.id)).toEqual([
    doubles.id,
  ]);
  expect((await list(owner.profileId, "game=four-shogi&mode=singles")).map((m) => m.id)).toEqual([
    shogi.record.id,
  ]);
  expect(await list(owner.profileId, "game=reversi")).toEqual([]);
});

test("公開プロフィールは表示用ID変更を越えて引き継ぎ済みの席とゲスト統合先を解決する", async () => {
  const registered = await player();
  const guest = await player();
  await db.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  const guestRecord = track(fixtureRecord(guest.id, 1));
  const claimable = track(humanFixtureRecord(registered.id, 2));
  const claimed = claimable.participants[0]!;
  if (claimed.kind !== "human") throw new Error("Expected a human seat");
  claimed.accountId = null;
  const unclaimedId = crypto.randomUUID();
  const unclaimed = {
    ...claimable,
    id: unclaimedId,
    instanceId: crypto.randomUUID(),
    replay: { ...claimable.replay, id: unclaimedId },
  };
  track(unclaimed);
  await seedStoredMatches(
    db,
    [guestRecord, claimable, unclaimed].map((record) => ({ record })),
  );

  const publicGuest = await request(profilePath(guest.profileId));
  expect(getPlayerProfileContract.response.parse(await publicGuest.json())).toMatchObject({
    kind: "account",
    isGuest: true,
    profileId: guest.profileId,
  });
  expect((await list(guest.profileId)).map((match) => match.id)).toEqual([guestRecord.id]);
  expect(await list(registered.profileId)).toEqual([]);
  expect(
    await acceptMatchClaim(db, {
      matchId: claimable.id,
      playerId: claimed.id,
      accountId: registered.id,
      roomId: claimable.roomId,
      instanceId: claimable.instanceId,
    }),
  ).toBe("applied");
  expect((await list(registered.profileId)).map((match) => match.id)).toEqual([claimable.id]);

  const username = `new_${registered.username.slice(2)}`;
  await db.batch([
    db.prepare("UPDATE user SET username=? WHERE id=?").bind(username, registered.id),
    db.prepare("INSERT INTO guest_account_merges VALUES (?, ?, 1)").bind(guest.id, registered.id),
    ...guestMatchAccountTransferStatements(db, guest.id, registered.id),
    ...guestReplayTransferStatements(db, guest.id, registered.id),
  ]);
  const migrated = await request(profilePath(guest.profileId));
  expect(getPlayerProfileContract.response.parse(await migrated.json())).toMatchObject({
    profileId: registered.profileId,
    username,
  });
  expect(await list(guest.profileId)).toEqual(await list(registered.profileId));
  expect((await list(registered.profileId)).map((match) => match.id).sort()).toEqual(
    [guestRecord.id, claimable.id].sort(),
  );
});

test("退会受付の直後から本人の公開一覧を閉じ、相手の公開要約では退会者を匿名化する", async () => {
  const owner = await player();
  const peer = await player();
  const outsider = await player();
  const record = track(humanFixtureRecord(owner.id, 1));
  const seat = record.participants[1]!;
  if (seat.kind !== "human") throw new Error("Expected a human seat");
  seat.accountId = peer.id;
  const oldAvatar = crypto.randomUUID();
  await db
    .prepare("UPDATE user SET name=?, avatarKey=? WHERE id=?")
    .bind("退会前の名", `avatars/${oldAvatar}.webp`, owner.id)
    .run();
  await writeMatch(db, record);
  expect((await list(peer.profileId))[0]!.participants[0]).toMatchObject({
    name: "退会前の名",
    avatarUrl: `/api/avatars/${oldAvatar}`,
  });
  // 受付済みの台帳と、まだ匿名化・削除されていない棋譜・索引を再現します。
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,1,?)")
    .bind(owner.id, crypto.randomUUID())
    .run();
  expect(
    await db
      .prepare("SELECT 1 FROM account_match_history WHERE account_id=? AND match_id=?")
      .bind(owner.id, record.id)
      .first(),
  ).not.toBeNull();
  for (const path of [profilePath(owner.profileId), listPath(owner.profileId)]) {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const [match] = await list(peer.profileId);
  expect(match!.id).toBe(record.id);
  expect(match!.participants[0]).toMatchObject({
    name: "退会したプレイヤー",
    retired: true,
    avatarUrl: null,
  });
  const body = JSON.stringify(match);
  for (const privateValue of [
    owner.id,
    peer.id,
    oldAvatar,
    owner.profileId,
    "退会前の名",
    "開始時の名前",
    '"profileId"',
    '"accountId"',
    '"selfPlayerId"',
    '"chat"',
    '"token"',
    '"membership"',
  ])
    expect(body).not.toContain(privateValue);

  const ownList = `/account/matches?${singles}`;
  const ownMatch = `/account/matches/${record.id}`;
  expect((await request(ownList)).status).toBe(401);
  expect((await request(ownMatch)).status).toBe(401);
  const others = { Cookie: outsider.cookie };
  expect(await (await request(`${ownList}&accountId=${peer.id}`, others)).json()).toEqual({
    matches: [],
    nextCursor: null,
  });
  expect((await request(ownMatch, others)).status).toBe(404);
});

test("履歴を読み取った直後に退会が確定すると、旧公開UUIDへの応答は404になる", async () => {
  const owner = await player();
  const record = track(fixtureRecord(owner.id, 1));
  await writeMatch(db, record);
  expect((await list(owner.profileId)).map((match) => match.id)).toEqual([record.id]);
  let accepted = false;
  const database = afterHistoryRead(async () => {
    accepted = await requestDeletion(bindings, owner.id, crypto.randomUUID());
  });

  const response = await request(listPath(owner.profileId), undefined, database);
  expect(accepted).toBe(true);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ message: "プロフィールを表示できません。" });
});

test("履歴読取中にゲスト統合先が変わると、その応答を404にして次の要求から統合先を返す", async () => {
  const guest = await player();
  const registered = await player();
  await db.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  const guestRecord = track(fixtureRecord(guest.id, 1));
  const registeredRecord = track(fixtureRecord(registered.id, 2));
  await writeMatch(db, guestRecord);
  await writeMatch(db, registeredRecord);
  const database = afterHistoryRead(async () => {
    await db.batch([
      db.prepare("INSERT INTO guest_account_merges VALUES (?, ?, 1)").bind(guest.id, registered.id),
      ...guestMatchAccountTransferStatements(db, guest.id, registered.id),
      ...guestReplayTransferStatements(db, guest.id, registered.id),
    ]);
  });

  const response = await request(listPath(guest.profileId), undefined, database);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ message: "プロフィールを表示できません。" });
  expect((await list(guest.profileId)).map((match) => match.id).sort()).toEqual(
    [guestRecord.id, registeredRecord.id].sort(),
  );
});

test("公開一覧は入力不正・閲覧不可・取得障害を区別し、すべてno-storeで応答する", async () => {
  const incomplete = await player(false);
  const missing = crypto.randomUUID();
  const registered = await player();
  for (const path of [
    listPath("invalid"),
    listPath(registered.profileId, "mode=singles"),
    listPath(registered.profileId, "game=unknown"),
    listPath(registered.profileId, "game=four-reversi"),
    listPath(registered.profileId, "game=four-reversi&mode=other"),
    listPath(registered.profileId, "game=reversi&mode=singles"),
  ]) {
    const response = await request(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  for (const id of [incomplete.profileId, missing]) {
    const response = await request(listPath(id));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(await (await request(profilePath(id))).json());
  }
  await db.exec("ALTER TABLE account_match_history RENAME TO unavailable_history");
  try {
    const response = await request(listPath(registered.profileId));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    await db.exec("ALTER TABLE unavailable_history RENAME TO account_match_history");
  }
});
