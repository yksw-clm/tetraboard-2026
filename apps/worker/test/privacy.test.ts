import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { legalVersion, analyticsRetentionMs, legalDocuments } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import {
  challengeCookie,
  flowCookie,
  digest,
  processDeletions,
  requestDeletion,
  responseCookies,
  completeReauthentication,
} from "../src/privacy/deletion";
import { accountIdentity } from "../src/accounts/auth";
import { writeMatch } from "../src/rooms/matchStore";
import { readStoredMatch, publicMatchDetail } from "../src/accounts/matchDataContracts";
import { advanceShogiMatchSave, type ShogiSaveProgress } from "../src/rooms/shogiMatchStore";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { standardShogiRecord } from "./standardShogiFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { reversiMatchData } from "../src/accounts/reversiMatchData";
import { gomokuMatchData } from "../src/accounts/gomokuMatchData";
import { fourGomokuMatchData } from "../src/accounts/fourGomokuMatchData";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomoku from "../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomoku from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import { archiveAnalytics } from "../src/analytics/retention";
import { analyticsVisitor, writeAnalyticsMatch, type AnalyticsMatch } from "../src/analytics/store";
import { readAnalytics, japanDay } from "../src/admin/metrics";
import worker from "../src/worker";
import { migrateOAuthTokens, unsealToken } from "../src/privacy/tokens";
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, { redirect: "manual", ...init }));
afterEach(() => vi.restoreAllMocks());

// 削除待ちの他テストのアカウントを処理せず、本人の失敗・再試行だけを検証します。
async function processFixtureDeletion(
  accountId: string,
  bindings: Parameters<typeof processDeletions>[0] = env,
) {
  const database = new Proxy(bindings.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (
            sql.startsWith("SELECT id,avatar_key,provider,revocation_token FROM deleted_accounts")
          )
            return target
              .prepare(sql.replace("completed_at_ms IS NULL", "completed_at_ms IS NULL AND id=?"))
              .bind(accountId);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await processDeletions({ ...bindings, APP_DB: database });
}

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

async function tombstone(id: string) {
  return requestDeletion(env, id, crypto.randomUUID() + crypto.randomUUID());
}
async function saved(id: string) {
  return (await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(id)
    .first<{ record_json: string }>())!.record_json;
}

test("全6ゲームの退会は本人だけを除去し、ゲスト名・盤面・相手履歴を保ち、古い再送も拒否する", async () => {
  const user = await accountFixture(),
    opponent = await accountFixture();
  const records = [
    humanFixtureRecord(user.id, 881),
    humanShogiRecord(user.id).record,
    reversiMatchData.read(
      JSON.stringify({
        ...reversi.detail,
        instanceId: crypto.randomUUID(),
        participants: reversi.detail.participants.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seat: p.seat,
          kind: "human",
          accountId: p.color === "black" ? user.id : null,
        })),
      }),
    ),
    standardShogiRecord(user.id, "win").record,
    gomokuMatchData.read(
      JSON.stringify({
        ...gomoku.detail,
        instanceId: crypto.randomUUID(),
        participants: gomoku.detail.participants.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seat: p.seat,
          kind: "human",
          accountId: p.color === "black" ? user.id : null,
        })),
      }),
    ),
    fourGomokuMatchData.read(fourGomoku.recordJson.replaceAll("fixture-self", user.id)),
  ];
  for (const record of records) {
    record.id = crypto.randomUUID();
    if ("id" in record.replay) record.replay.id = record.id;
    const self = record.participants.find((p) => p.kind === "human" && p.accountId === user.id)!;
    expect(self).toBeDefined();
    self.name = "削除する旧名";
    const other = record.participants.find((p) => p.kind === "human" && p !== self)!;
    if (other.kind !== "human") throw new Error("Human fixture missing");
    other.accountId = opponent.id;
    await env.APP_DB.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?)")
      .bind(
        record.id,
        record.settings.game,
        "mode" in record.settings ? record.settings.mode : "singles",
        record.startedAtMs,
        record.endedAtMs,
        JSON.stringify(record),
      )
      .run();
    await env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,game,mode,started_at_ms) VALUES (?,?,?,?,?)",
    )
      .bind(opponent.id, record.id, record.settings.game, "singles", record.startedAtMs)
      .run();
  }
  expect(await tombstone(user.id)).toBe(true);
  expect(
    await accountIdentity(new Request(origin, { headers: { Cookie: user.cookie } }), env),
  ).toBeNull();
  for (const record of records) {
    const raw = await saved(record.id);
    expect(raw).not.toContain(user.id);
    expect(raw).not.toContain("削除する旧名");
    const parsed = JSON.parse(raw);
    expect(parsed.game).toEqual(record.game);
    expect(parsed.replay).toEqual(record.replay);
    expect(parsed.settings).toEqual(record.settings);
    const self = parsed.participants.find((p: { retired?: boolean }) => p.retired);
    expect(self).toMatchObject({ name: "退会したプレイヤー", accountId: null, retired: true });
    expect(parsed.participants.filter((p: { retired?: boolean }) => !p.retired)).toEqual(
      record.participants.filter((p) => !(p.kind === "human" && p.accountId === user.id)),
    );
    const detail = publicMatchDetail(readStoredMatch(raw, record.settings.game), new Map());
    expect(detail.participants.find((p) => p.id === self.id)).toMatchObject({
      name: "退会したプレイヤー",
      retired: true,
    });
    await env.APP_DB.prepare("UPDATE matches SET record_json=? WHERE id=?")
      .bind(JSON.stringify(record), record.id)
      .run();
    expect(await saved(record.id)).not.toContain(user.id);
    await env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,game,mode,started_at_ms) VALUES (?,?,?,?,?)",
    )
      .bind(user.id, record.id, record.settings.game, "singles", record.startedAtMs)
      .run();
  }
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) count FROM account_match_history WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) count FROM account_match_history WHERE account_id=?")
      .bind(opponent.id)
      .first(),
  ).toEqual({ count: 6 });
  // 書込み関数に渡される古いDOメタデータもマスキングする。
  const late = humanFixtureRecord(user.id, 882);
  await writeMatch(env.APP_DB, late);
  expect(await saved(late.id)).not.toContain(user.id);
});

for (const standard of [false, true])
  test(`${standard ? "通常" : "四人"}将棋: 転送途中に退会しても照合・再送・相手索引を維持する`, async () => {
    const user = await accountFixture(),
      opponent = await accountFixture();
    const fixture = standard
      ? standardShogiRecord(user.id, "win", false, 110)
      : humanShogiRecord(user.id);
    const other = fixture.record.participants.find(
      (p) => p.kind === "human" && p.accountId !== user.id,
    )!;
    if (other.kind !== "human") throw new Error("Human fixture missing");
    other.accountId = opponent.id;
    const source = (cursor: number) => fixture.events.slice(cursor, cursor + 100);
    const next = await advanceShogiMatchSave(
      env.APP_DB,
      fixture.record,
      { phase: "upload", cursor: 0 },
      source,
    );
    expect(next).not.toBeNull();
    expect(await tombstone(user.id)).toBe(true);
    let progress: ShogiSaveProgress | null = next;
    for (let i = 0; progress && i < 10; i++)
      progress = await advanceShogiMatchSave(env.APP_DB, fixture.record, progress, source);
    expect(progress).toBeNull();
    const raw = await saved(fixture.record.id);
    expect(raw).not.toContain(user.id);
    expect(JSON.parse(raw).game).toEqual(fixture.record.game);
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
        .bind(fixture.record.id)
        .all(),
    ).toMatchObject({ results: [{ account_id: opponent.id }] });
    expect(
      await advanceShogiMatchSave(
        env.APP_DB,
        fixture.record,
        { phase: "upload", cursor: 0 },
        source,
      ),
    ).toBeNull();
  });

async function verified(
  user: Awaited<ReturnType<typeof accountFixture>>,
  expiry = Date.now() + 600000,
) {
  const challenge = crypto.randomUUID();
  const session = await env.APP_DB.prepare("SELECT id FROM session WHERE token=?")
    .bind(user.token)
    .first<{ id: string }>();
  await env.APP_DB.prepare(
    "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms,verified_at_ms,verified_session_id) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(challenge, user.id, "google", Date.now(), expiry, Date.now(), session!.id)
    .run();
  const flow = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO deletion_flows VALUES (?,?,?)")
    .bind(flow, user.id, Date.now() + 86400000)
    .run();
  return `${user.cookie}; ${challengeCookie}=${challenge}; ${flowCookie}=${flow}`;
}
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

test("DO内の席・保存待ち・直前局・チャットの本人表示と画像参照を削除する", async () => {
  const user = await accountFixture();
  expect(await tombstone(user.id)).toBe(true);
  const stub = env.GAME_ROOM.getByName("privacy-purge-fixture"),
    playerId = crypto.randomUUID(),
    avatarKey = `avatars/${crypto.randomUUID()}.webp`;
  await runInDurableObject(stub, async (_, state) => {
    state.storage.kv.put(`seat-account:${playerId}`, {
      accountId: user.id,
      playerId,
      operationId: "privacy-operation",
      instanceId: "privacy-instance",
      avatarKey,
      name: "秘密名",
      occupying: false,
    });
    state.storage.kv.put(`player-token:${playerId}`, "oldtoken");
    state.storage.kv.put("membership:oldtoken", { playerId, role: "player" });
    state.storage.kv.put("privacy-saved", {
      participants: [
        { id: playerId, kind: "human", accountId: user.id, name: "秘密名" },
        { id: "guest", kind: "human", accountId: null, name: "ゲスト名" },
      ],
      lastRound: {
        players: [
          {
            id: playerId,
            name: "秘密名",
            appearance: { kind: "human", avatarUrl: "/api/avatars/secret" },
          },
        ],
      },
    });
    state.storage.kv.put("chat", [
      {
        id: crypto.randomUUID(),
        senderId: playerId,
        senderName: "秘密名",
        text: "挨拶",
        sentAtMs: Date.now(),
      },
    ]);
    state.storage.kv.put("analytics-active", {
      participants: [{ playerId, accountId: user.id, visitorId: crypto.randomUUID() }],
    });
  });
  await stub.purgeAccount(user.id);
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, state) => {
    const values = [...state.storage.kv.list()].map(([, value]) => value);
    const json = JSON.stringify(values);
    expect(json).not.toContain("秘密名");
    expect(json).not.toContain(user.id);
    expect(json).not.toContain("/api/avatars/secret");
    expect(json).toContain("ゲスト名");
    expect(state.storage.kv.get("membership:oldtoken")).toBeUndefined();
    expect(state.storage.kv.get(`seat-account:${playerId}`)).toBeUndefined();
    expect(state.storage.kv.get("analytics-active")).toEqual({
      participants: [{ playerId, accountId: null, visitorId: null }],
    });
  });
  expect(
    await env.APP_DB.prepare("SELECT key FROM deletion_images WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ key: avatarKey });
});

test("R2失敗は処理中を維持して再試行し、完了時は認証・同意・画像を削除して再登録を新規とする", async () => {
  const user = await accountFixture();
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, "private image");
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
  const receipt = crypto.randomUUID() + crypto.randomUUID();
  expect(await requestDeletion(env, user.id, receipt)).toBe(true);
  // 他テストの部屋に依存せず、この受付の画像段階を検証します。
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  const failure = {
    ...env,
    OBJECT_STORAGE: {
      delete: async () => {
        throw new Error("unavailable");
      },
    } as unknown as R2Bucket,
  };
  await processFixtureDeletion(user.id, failure);
  expect(
    await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ completed_at_ms: null });
  await processFixtureDeletion(user.id);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
  for (const [table, column] of [
    ["user", "id"],
    ["session", "userId"],
    ["legal_consents", "account_id"],
  ])
    expect(
      await env.APP_DB.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).bind(user.id).first(),
    ).toBeNull();
  expect(
    (await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first<{ completed_at_ms: number }>())!.completed_at_ms,
  ).toBeGreaterThan(0);
  const fresh = await accountFixture();
  expect(fresh.id).not.toBe(user.id);
  expect(
    await accountIdentity(new Request(origin, { headers: { Cookie: fresh.cookie } }), env),
  ).not.toBeNull();
});

test("利用計測は常時有効で旧選択Cookieに依存せず、90日境界で集計・削除する", async () => {
  const browser = crypto.randomUUID();
  const cookies = `tetraboard-2026.analytics=${browser}; tetraboard-2026.analytics-choice=off`;
  expect(analyticsVisitor(new Request(origin, { headers: { Cookie: cookies } }))).toBe(browser);
  const viewId = crypto.randomUUID();
  expect(
    (
      await request("/analytics/pageviews", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookies, "Content-Type": "application/json" },
        body: JSON.stringify({ id: viewId, page: "lobby", game: "four-reversi" }),
      })
    ).status,
  ).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT visitor_id FROM analytics_pageviews WHERE id=?")
      .bind(viewId)
      .first(),
  ).toEqual({ visitor_id: browser });
  expect(
    (
      await request("/analytics/choice", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
  ).toBe(404);
  const now = Date.now(),
    cutoff = now - analyticsRetentionMs,
    day = japanDay(cutoff),
    nextDay = japanDay(cutoff + 86400000),
    id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO analytics_pageviews(id,visitor_id,page,game,started_at_ms) VALUES (?,?,'lobby','gomoku',?)",
  )
    .bind(id, browser, cutoff)
    .run();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO analytics_dwell VALUES (?,?,?)").bind(id, day, 100),
    env.APP_DB.prepare("INSERT INTO analytics_dwell VALUES (?,?,?)").bind(id, nextDay, 200),
  ]);
  const before = await env.APP_DB.prepare(
    "SELECT SUM(page_views) count FROM analytics_daily WHERE game='gomoku' AND internal=0",
  ).first<{ count: number | null }>();
  await archiveAnalytics(env, now);
  await archiveAnalytics(env, now);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_pageviews WHERE id=?").bind(id).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_dwell WHERE view_id=?").bind(id).first(),
  ).toBeNull();
  expect(
    (await env.APP_DB.prepare(
      "SELECT SUM(page_views) count FROM analytics_daily WHERE game='gomoku' AND internal=0",
    ).first<{ count: number }>())!.count,
  ).toBe((before?.count ?? 0) + 1);
  expect(
    (await env.APP_DB.prepare(
      "SELECT dwell_ms FROM analytics_daily WHERE day=? AND game='gomoku' AND internal=0",
    )
      .bind(nextDay)
      .first<{ dwell_ms: number }>())!.dwell_ms,
  ).toBeGreaterThanOrEqual(200);
  const record: AnalyticsMatch = {
    id: crypto.randomUUID(),
    game: "gomoku",
    mode: "singles",
    startedAtMs: cutoff,
    endedAtMs: cutoff + 100,
    status: "completed",
    cpuCount: 0,
    participants: [
      { playerId: crypto.randomUUID(), accountId: null, visitorId: browser, isTest: false },
    ],
  };
  await writeAnalyticsMatch(env.APP_DB, record);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_matches WHERE id=?").bind(record.id).first(),
  ).toBeNull();
  await env.APP_DB.prepare("INSERT OR REPLACE INTO analytics_metadata VALUES ('collected_from',?)")
    .bind(cutoff - 1)
    .run();
  const data = await readAnalytics(env, {
    from: day,
    to: nextDay,
    bucket: "day",
    game: "gomoku",
    includeInternal: "false",
  });
  expect(data.summary.visitors).toBeNull();
  expect(data.summary.startRate).toBeNull();
  expect(data.summary.pageViews).toBeGreaterThan(0);
});

test("旧OAuthトークンを暗号化し、解除の失敗を成功にせず再試行する", async () => {
  const user = await accountFixture(),
    token = "legacy-private-provider-token";
  await env.APP_DB.prepare(
    "INSERT INTO account(id,accountId,providerId,userId,accessToken,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      crypto.randomUUID(),
      "google",
      user.id,
      token,
      Date.now(),
      Date.now(),
    )
    .run();
  await migrateOAuthTokens(env);
  const sealed = (await env.APP_DB.prepare("SELECT accessToken FROM account WHERE userId=?")
    .bind(user.id)
    .first<{ accessToken: string }>())!.accessToken;
  expect(sealed).not.toBe(token);
  expect(await unsealToken(env, sealed)).toBe(token);
  expect(await tombstone(user.id)).toBe(true);
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init!.body)).toContain(token);
    return Response.json({ error: "invalid_client" }, { status: 400 });
  });
  await processFixtureDeletion(user.id);
  expect(
    await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ completed_at_ms: null });
  mock.mockImplementation(async () => Response.json({ error: "invalid_token" }, { status: 400 }));
  await processFixtureDeletion(user.id);
  expect(
    (await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
      .bind(user.id)
      .first<{ completed_at_ms: number }>())!.completed_at_ms,
  ).toBeGreaterThan(0);
});

for (const provider of ["google", "discord"] as const)
  test(`${provider}: 実コールバック経路で取消・別人・期限・正常再認証と新規再登録を確認する`, async () => {
    let providerId = String(Date.now()) + String(Math.floor(Math.random() * 100000)),
      email = `${crypto.randomUUID()}@example.test`;
    const cookies = (r: Response) =>
      r.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/revoke")) return new Response(null, { status: 200 });
      if (url.includes("/token")) {
        const jwt = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: providerId, email, email_verified: true, name: "External private name", picture: "https://private.test/avatar" }))}.fake`;
        return Response.json({
          access_token: "provider-private-token",
          refresh_token: "unneeded-refresh",
          id_token: jwt,
          token_type: "Bearer",
          expires_in: 3600,
          scope: provider === "google" ? "openid email profile" : "identify email",
        });
      }
      if (decodeURIComponent(url).endsWith("/users/@me"))
        return Response.json({
          id: providerId,
          email,
          username: "外部非公開名",
          verified: true,
          avatar: null,
          discriminator: "0",
        });
      throw new Error("Unexpected OAuth request");
    });
    const signIn = async () => {
      const response = await request("/auth/sign-in/social", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Legal-Consent": legalVersion,
        },
        body: JSON.stringify({ provider }),
      });
      expect(response.status).toBe(200);
      const url = new URL(((await response.json()) as { url: string }).url);
      if (provider === "google") {
        expect(url.searchParams.get("access_type")).toBe("online");
        expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual([
          "email",
          "openid",
          "profile",
        ]);
      }
      return { state: url.searchParams.get("state")!, cookie: cookies(response) };
    };
    const callback = async (flow: { state: string; cookie: string }, cancel = false) =>
      request(
        `/auth/callback/${provider}?${cancel ? "error=access_denied" : "code=test-code"}&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: flow.cookie } },
      );
    const first = await callback(await signIn());
    const initialCookie = responseCookies(new Request(origin), first).get("Cookie")!;
    const user = (await env.APP_DB.prepare("SELECT id,name,image FROM user WHERE email=?")
      .bind(email)
      .first<{ id: string; name: string; image: string | null }>())!;
    expect(user.name).toBe("");
    expect(user.image).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
        .bind(user.id)
        .first(),
    ).toEqual({ version: legalVersion });
    const tokens = await env.APP_DB.prepare(
      "SELECT accessToken,refreshToken,idToken FROM account WHERE userId=?",
    )
      .bind(user.id)
      .first<{ accessToken: string; refreshToken: null; idToken: null }>();
    expect(tokens?.refreshToken).toBeNull();
    expect(tokens?.idToken).toBeNull();
    expect(tokens?.accessToken).not.toBe("provider-private-token");
    expect(await unsealToken(env, tokens!.accessToken)).toBe("provider-private-token");
    const reauth = async (cookie: string) => {
      const response = await request("/account/deletion/reauth", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const url = new URL(((await response.json()) as { url: string }).url);
      expect(url.searchParams.get("prompt")).toBe(
        provider === "google" ? "select_account" : "consent",
      );
      return {
        state: url.searchParams.get("state")!,
        cookie: responseCookies(new Request(origin, { headers: { Cookie: cookie } }), response).get(
          "Cookie",
        )!,
      };
    };
    expect(
      await accountIdentity(new Request(origin, { headers: { Cookie: initialCookie } }), env),
    ).not.toBeNull();
    const canceled = await reauth(initialCookie);
    await callback(canceled, true);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(canceled.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    const wrong = await reauth(initialCookie);
    const originalId = providerId,
      originalEmail = email;
    providerId = String(Date.now()) + String(Math.floor(Math.random() * 100000));
    email = `${crypto.randomUUID()}@example.test`;
    await callback(wrong);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(wrong.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    providerId = originalId;
    email = originalEmail;
    const expired = await reauth(initialCookie);
    await env.APP_DB.prepare("UPDATE deletion_challenges SET expires_at_ms=? WHERE oauth_state=?")
      .bind(Date.now() - 1, expired.state)
      .run();
    await callback(expired);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(expired.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    const valid = await reauth(initialCookie);
    const authenticated = await callback(valid);
    const newCookie = `${valid.cookie
      .split("; ")
      .filter((v) => !v.startsWith("tetraboard-2026.session_token="))
      .join("; ")}; ${cookies(authenticated)}`;
    const row = await env.APP_DB.prepare(
      "SELECT verified_at_ms,verified_session_id FROM deletion_challenges WHERE oauth_state=?",
    )
      .bind(valid.state)
      .first<{ verified_at_ms: number; verified_session_id: string }>();
    expect(row!.verified_at_ms).toBeGreaterThan(0);
    expect(row!.verified_session_id).toBeTruthy();
    expect(
      (await request("/account/deletion/confirmation", { headers: { Cookie: newCookie } })).status,
    ).toBe(200);
    const response = await request("/account/deletion/confirm", {
      method: "POST",
      headers: { Origin: origin, Cookie: newCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(202);
    await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
    await processFixtureDeletion(user.id);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM account WHERE userId=?").bind(user.id).first(),
    ).toBeNull();
    await callback(await signIn());
    const fresh = await env.APP_DB.prepare("SELECT id FROM user WHERE email=?")
      .bind(email)
      .first<{ id: string }>();
    expect(fresh!.id).not.toBe(user.id);
    mock.mockRestore();
  });

test("退会はDOの計測識別を除去し、遅延した開始記録で本人識別を復活させない", async () => {
  const user = await accountFixture(),
    browser = crypto.randomUUID();
  const record: AnalyticsMatch = {
    id: crypto.randomUUID(),
    game: "four-reversi",
    mode: "singles",
    startedAtMs: Date.now(),
    endedAtMs: null,
    status: "playing",
    cpuCount: 0,
    participants: [
      { playerId: crypto.randomUUID(), accountId: user.id, visitorId: browser, isTest: false },
    ],
  };
  const stub = env.GAME_ROOM.getByName("privacy-retired-analytics");
  await runInDurableObject(stub, async (_, ctx) => ctx.storage.kv.put("analytics-active", record));
  expect(await tombstone(user.id)).toBe(true);
  await stub.purgeAccount(user.id);
  await writeAnalyticsMatch(env.APP_DB, record);
  expect(
    await env.APP_DB.prepare(
      "SELECT 1 FROM analytics_participants WHERE match_id=? AND (account_id=? OR visitor_id=?)",
    )
      .bind(record.id, user.id, browser)
      .first(),
  ).toBeNull();
  await runInDurableObject(stub, async (_, ctx) =>
    expect(ctx.storage.kv.get<AnalyticsMatch>("analytics-active")!.participants[0]).toMatchObject({
      accountId: null,
      visitorId: null,
    }),
  );
});

test("複数退会者と元から存在しない参照を区別し、相手の公開棋譜・戦績を維持する", async () => {
  const first = await accountFixture(),
    second = await accountFixture(),
    opponent = await accountFixture();
  const record = humanFixtureRecord(first.id, 901);
  const people = record.participants.filter((p) => p.kind === "human");
  people[1].accountId = second.id;
  people[2].accountId = opponent.id;
  people[3].accountId = "preexisting-missing-account";
  people[3].name = "昔の保存名";
  await writeMatch(env.APP_DB, record);
  expect(await tombstone(first.id)).toBe(true);
  expect(await tombstone(second.id)).toBe(true);
  const response = await request(`/matches/${record.id}`);
  expect(response.status).toBe(200);
  const detail = (
    (await response.json()) as { match: { participants: { name: string; retired?: boolean }[] } }
  ).match;
  expect(detail.participants.filter((p) => p.retired)).toHaveLength(2);
  expect(detail.participants.some((p) => p.name === "昔の保存名" && !p.retired)).toBe(true);
  const history = await request("/account/matches?game=four-reversi&mode=singles", {
    headers: { Cookie: opponent.cookie },
  });
  expect(history.status).toBe(200);
  expect(JSON.stringify(await history.json())).toContain(record.id);
  const stats = await request("/account/stats?game=four-reversi", {
    headers: { Cookie: opponent.cookie },
  });
  expect(stats.status).toBe(200);
  expect(JSON.stringify(await stats.json())).toContain('"total":1');
});

test("受付後はセッション・編集・画像の再作成を拒否し、完了後の索引再送も旧名に戻らない", async () => {
  const user = await accountFixture(),
    player = crypto.randomUUID(),
    instance = crypto.randomUUID(),
    key = `avatars/${crypto.randomUUID()}.webp`,
    roomId = "99778";
  await env.OBJECT_STORAGE.put(key, "private");
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(key, user.id).run();
  await env.APP_DB.prepare("INSERT INTO privacy_room_players VALUES (?,?,?,?,?)")
    .bind(user.id, roomId, instance, player, key)
    .run();
  expect(await tombstone(user.id)).toBe(true);
  expect((await request(`/avatars/${key.slice(8, -5)}`)).status).toBe(404);
  await env.APP_DB.prepare("UPDATE user SET name='復活する旧名',profileCompleted=1 WHERE id=?")
    .bind(user.id)
    .run();
  expect(
    await env.APP_DB.prepare("SELECT name,profileCompleted FROM user WHERE id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ name: "退会したプレイヤー", profileCompleted: 0 });
  await env.APP_DB.prepare(
    "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      crypto.randomUUID(),
      Date.now() + 100000,
      Date.now(),
      Date.now(),
    )
    .run();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM session WHERE userId=?").bind(user.id).first(),
  ).toBeNull();
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  await processFixtureDeletion(user.id);
  await env.APP_DB.prepare(
    "INSERT INTO room_index(room_id,game,mode,main_time_ms,byoyomi_ms,status,host_name,human_count,cpu_count,capacity,open_seats,updated_at_ms,revision,closed,instance_id,host_player_id,host_avatar_url) VALUES (?,'four-reversi','singles',300000,30000,'waiting','復活する旧名',1,0,4,3,?,1,0,?,?,?)",
  )
    .bind(roomId, Date.now(), instance, player, `/api/avatars/${key.slice(8, -5)}`)
    .run();
  expect(
    await env.APP_DB.prepare(
      "SELECT host_name,host_avatar_url,host_player_id FROM room_index WHERE room_id=?",
    )
      .bind(roomId)
      .first(),
  ).toEqual({ host_name: "退会したプレイヤー", host_avatar_url: null, host_player_id: null });
});

test("本人の新旧フィードバック・画像・編集履歴・計測・投稿制限を消し、他者の投稿を残す", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const post = async (cookie: string) => {
    const body = new FormData();
    body.set(
      "input",
      JSON.stringify({
        submissionId: crypto.randomUUID(),
        kind: "bug",
        game: "four-reversi",
        body: "本人だけが提出した原文",
        expectation: "正常表示",
        steps: "画面を開く",
        technical: null,
      }),
    );
    const response = await request("/feedback", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      body,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const ids = [await post(user.cookie), await post(user.cookie)],
    others = await post(other.cookie);
  await env.APP_DB.prepare("UPDATE feedback SET account_id=NULL WHERE id=?").bind(ids[0]).run();
  const key = `feedback/${ids[0]}.webp`;
  await env.OBJECT_STORAGE.put(key, "private feedback");
  await env.APP_DB.prepare("UPDATE feedback SET attachment_key=? WHERE id=?")
    .bind(key, ids[0])
    .run();
  await env.APP_DB.prepare("INSERT INTO feedback_history VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), ids[0], other.id, "編集者", Date.now(), '{"before":"原文"}')
    .run();
  const view = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO analytics_pageviews(id,visitor_id,account_id,page,game,started_at_ms) VALUES (?,?,?,'lobby','four-reversi',?)",
  )
    .bind(view, crypto.randomUUID(), user.id, Date.now())
    .run();
  await env.APP_DB.prepare("INSERT INTO analytics_dwell VALUES (?,?,1)")
    .bind(view, japanDay(Date.now()))
    .run();
  expect(await tombstone(user.id)).toBe(true);
  for (const id of ids)
    expect(
      await env.APP_DB.prepare("SELECT deleted FROM feedback WHERE id=?").bind(id).first(),
    ).toEqual({ deleted: 1 });
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  await processFixtureDeletion(user.id);
  for (const id of ids) {
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM feedback WHERE id=?").bind(id).first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM feedback_history WHERE feedback_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  }
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_pageviews WHERE id=?").bind(view).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_dwell WHERE view_id=?").bind(view).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM feedback WHERE id=?").bind(others).first(),
  ).not.toBeNull();
});

test("長期集計は期限前に未完了だった対局の率・時間を推測せず、退会後も登録数の匿名集計を保つ", async () => {
  const user = await accountFixture(),
    at = Date.parse("2005-01-02T12:00:00+09:00");
  await env.APP_DB.prepare("UPDATE user SET createdAt=? WHERE id=?").bind(at, user.id).run();
  await env.APP_DB.prepare("INSERT OR REPLACE INTO analytics_metadata VALUES ('collected_from',?)")
    .bind(at - 86400000)
    .run();
  const query = {
    from: "2005-01-02",
    to: "2005-01-02",
    bucket: "day" as const,
    game: "all" as const,
    includeInternal: "false" as const,
  };
  expect((await readAnalytics(env, query)).summary.newUsers).toBe(1);
  expect(await tombstone(user.id)).toBe(true);
  expect((await readAnalytics(env, query)).summary.newUsers).toBe(1);
  await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
  await processFixtureDeletion(user.id);
  await processFixtureDeletion(user.id);
  expect((await readAnalytics(env, query)).summary.newUsers).toBe(1);
  const id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO analytics_matches VALUES (?,'four-reversi','singles',?,NULL,'playing',0)",
  )
    .bind(id, at)
    .run();
  await env.APP_DB.prepare("INSERT INTO analytics_participants VALUES (?,?,NULL,?,0)")
    .bind(id, crypto.randomUUID(), crypto.randomUUID())
    .run();
  const data = await readAnalytics(env, query);
  expect(data.summary.started).toBeGreaterThan(0);
  expect(data.summary.playing).toBeNull();
  expect(data.summary.completionRate).toBeNull();
  expect(data.summary.participationMs).toBeNull();
  expect(data.summary.registeredRetentionEligible).toBeNull();
});

test("退会と同時に失敗したDO棋譜保存は、現在のマスク済み保存待ちを保って再試行する", async () => {
  const user = await accountFixture(),
    record = humanFixtureRecord(user.id, 911);
  record.participants[0].name = "削除する保存名";
  expect(await tombstone(user.id)).toBe(true);
  const stub = env.GAME_ROOM.getByName("privacy-inflight-save");
  await runInDurableObject(stub, async (instance, state) => {
    const owned = instance as unknown as { env: Env; flushMatches: () => Promise<void> };
    const original = owned.env;
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    owned.env = {
      ...original,
      APP_DB: {
        prepare: (sql: string) => original.APP_DB.prepare(sql),
        batch: async () => {
          start();
          await gate;
          throw new Error("Unavailable");
        },
      } as unknown as D1Database,
    };
    const key = `match-pending:${record.id}`;
    state.storage.kv.put(key, { record, retryAtMs: Date.now() });
    try {
      const flushing = owned.flushMatches();
      await started;
      await instance.purgeAccount(user.id);
      release();
      await flushing;
      const stored = JSON.stringify(state.storage.kv.get(key));
      expect(stored).not.toContain(user.id);
      expect(stored).not.toContain("削除する保存名");
      expect(stored).toContain("退会したプレイヤー");
    } finally {
      release();
      owned.env = original;
    }
  });
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
  const user = await accountFixture();
  await env.APP_DB.prepare(
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
    cookie = await verified(second);
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
});

test("集計後の削除が失敗してもD1 batchを巻き戻し、再試行で集計を二重加算しない", async () => {
  const at = Date.now() - analyticsRetentionMs - 1,
    day = japanDay(at),
    id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO analytics_pageviews(id,visitor_id,page,game,started_at_ms) VALUES (?,?,'lobby','four-gomoku',?)",
  )
    .bind(id, crypto.randomUUID(), at)
    .run();
  const count = async () =>
    Number(
      (
        await env.APP_DB.prepare(
          "SELECT SUM(page_views) count FROM analytics_daily WHERE day=? AND game='four-gomoku' AND internal=0",
        )
          .bind(day)
          .first<{ count: number | null }>()
      )?.count ?? 0,
    );
  const before = await count();
  const broken = {
    ...env,
    APP_DB: {
      prepare: (sql: string) => env.APP_DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) =>
        env.APP_DB.batch([
          ...statements.slice(0, 6),
          env.APP_DB.prepare("DELETE FROM privacy_nonexistent_table"),
          ...statements.slice(6),
        ]),
    } as unknown as D1Database,
  };
  await expect(archiveAnalytics(broken)).rejects.toThrow();
  expect(await count()).toBe(before);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_pageviews WHERE id=?").bind(id).first(),
  ).not.toBeNull();
  await archiveAnalytics(env);
  await archiveAnalytics(env);
  expect(await count()).toBe(before + 1);
});

test("退会受付中に到着する新しいプロフィール画像も発見し、R2失敗を再試行する", async () => {
  const user = await accountFixture(),
    bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 24, true);
  view.setUint32(16, 12, true);
  bytes[20] = 0x2f;
  view.setUint32(21, 255 | (255 << 14), true);
  let uploaded = "";
  const original = env.OBJECT_STORAGE;
  const storage = {
    put: async (key: string, value: Uint8Array, options: R2PutOptions) => {
      uploaded = key;
      expect(await tombstone(user.id)).toBe(true);
      await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
      await processFixtureDeletion(user.id);
      expect(
        await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
          .bind(user.id)
          .first(),
      ).toEqual({ completed_at_ms: null });
      return original.put(key, value, options);
    },
    delete: async () => {
      throw new Error("Unavailable");
    },
  } as unknown as R2Bucket;
  const body = new FormData();
  body.set("name", "本人");
  body.set("username", user.username);
  body.set("avatarAction", "replace");
  body.set("avatar", new File([bytes], "avatar.webp", { type: "image/webp" }));
  const response = await worker.fetch(
    new Request(`${origin}/api/account/profile`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: user.cookie },
      body,
    }),
    { ...env, OBJECT_STORAGE: storage },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(503);
  expect(uploaded).toBeTruthy();
  expect(await original.get(uploaded)).not.toBeNull();
  await processFixtureDeletion(user.id);
  expect(await original.get(uploaded)).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM privacy_avatar_uploads WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();
});

test("本番の__Secure認証Cookieでも同意・再認証を保存し、退会時に失効Cookieを返す", async () => {
  const production = "https://tetraboard.net" as const,
    bindings = { ...env, APP_ORIGIN: production },
    email = `${crypto.randomUUID()}@example.test`,
    subject = crypto.randomUUID();
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`${production}/api${path}`, { redirect: "manual", ...init }),
      bindings,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  const jwt = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ sub: subject, email, email_verified: true, name: "private" }))}.fake`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      access_token: "secure-provider-token",
      id_token: jwt,
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  const begin = await call("/auth/sign-in/social", {
    method: "POST",
    headers: {
      Origin: production,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
    },
    body: JSON.stringify({ provider: "google" }),
  });
  expect(begin.status).toBe(200);
  const state = new URL(((await begin.json()) as { url: string }).url).searchParams.get("state")!;
  const flow = responseCookies(new Request(production), begin).get("Cookie")!;
  const done = await call(
    `/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: flow } },
  );
  const cookie = responseCookies(new Request(production, { headers: { Cookie: flow } }), done).get(
    "Cookie",
  )!;
  expect(cookie).toContain("__Secure-tetraboard-2026.session_token=");
  const user = (await env.APP_DB.prepare("SELECT id FROM user WHERE email=?")
    .bind(email)
    .first<{ id: string }>())!;
  expect(
    await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ version: legalVersion });
  const start = await call("/account/deletion/reauth", {
    method: "POST",
    headers: { Origin: production, Cookie: cookie },
  });
  expect(start.status).toBe(200);
  const url = new URL(((await start.json()) as { url: string }).url),
    challenge = responseCookies(
      new Request(production, { headers: { Cookie: cookie } }),
      start,
    ).get("Cookie")!;
  const authenticated = await call(
    `/auth/callback/google?code=test-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    { headers: { Cookie: challenge } },
  );
  const fresh = responseCookies(
    new Request(production, { headers: { Cookie: challenge } }),
    authenticated,
  ).get("Cookie")!;
  const response = await call("/account/deletion/confirm", {
    method: "POST",
    headers: { Origin: production, Cookie: fresh, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  expect(response.status).toBe(202);
  expect(response.headers.getSetCookie()).toContain(
    "__Secure-tetraboard-2026.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure",
  );
});

test("再認証のキャンセル応答は同時刻の既存セッションを本人確認に使わない", async () => {
  const user = await accountFixture();
  const session = await env.APP_DB.prepare("SELECT createdAt FROM session WHERE token=?")
    .bind(user.token)
    .first<{ createdAt: number }>();
  const id = crypto.randomUUID(),
    state = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms,oauth_state) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, user.id, "google", session!.createdAt, Date.now() + 600000, state)
    .run();
  await completeReauthentication(
    new Request(`${origin}/api/auth/callback/google?error=access_denied&state=${state}`, {
      headers: { Cookie: `${user.cookie}; ${challengeCookie}=${id}` },
    }),
    new Response(null, { status: 302, headers: { Location: `${origin}/account/deletion` } }),
    env,
  );
  expect(
    await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE id=?")
      .bind(id)
      .first(),
  ).toEqual({ verified_at_ms: null });
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

test("閉鎖済みDOの索引保存待ちだけに残ったホスト名も保持した資格の対応から削除する", async () => {
  const user = await accountFixture(),
    room = "98477",
    player = crypto.randomUUID();
  await env.APP_DB.prepare("INSERT INTO privacy_room_players VALUES (?,?,?,?,NULL)")
    .bind(user.id, room, crypto.randomUUID(), player)
    .run();
  expect(await tombstone(user.id)).toBe(true);
  const stub = env.GAME_ROOM.getByName(room);
  await runInDurableObject(stub, async (_, ctx) => {
    ctx.storage.kv.put("room-index-pending", {
      revision: 1,
      closed: true,
      retryAtMs: Date.now(),
      metadata: {
        id: room,
        hostPlayerId: player,
        hostName: "閉鎖後の保存名",
        hostAvatarUrl: "/api/avatars/private",
      },
    });
  });
  await stub.purgeAccount(user.id);
  await runInDurableObject(stub, async (_, ctx) => {
    const value = ctx.storage.kv.get<{
      metadata: { hostName: string; hostAvatarUrl: string | null };
    }>("room-index-pending")!;
    expect(value.metadata.hostName).toBe("退会したプレイヤー");
    expect(value.metadata.hostAvatarUrl).toBeNull();
    expect(JSON.stringify([...ctx.storage.kv.list()])).not.toContain("閉鎖後の保存名");
  });
});
