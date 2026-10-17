import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  tournamentAdminEntriesSchema,
  tournamentAdminListSchema,
  tournamentDetailSchema,
  tournamentLobbySchema,
  tournamentRecordSchema,
  tournamentStandingsSchema,
  type TournamentInput,
  type TournamentRecord,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import type { AdminEnv } from "../src/admin/auth";
import { accountFixture, origin } from "./accountFixtures";

const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const fetchWith = (path: string, init?: RequestInit, bindings: AdminEnv = env) =>
  worker.fetch(new Request(origin + path, init), bindings as Env, context);
const input = (overrides: Partial<TournamentInput> = {}): TournamentInput => ({
  name: "第一回 四人将棋大会",
  description: "初参加も歓迎します。\r\n途中参加できます。",
  rulesDescription: "気軽に参加してください。",
  startsAtMs: Date.now() + 3600000,
  endsAtMs: Date.now() + 7200000,
  ...overrides,
});
async function admin() {
  const user = await accountFixture();
  return { user, bindings: { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([user.id]) } };
}
type Admin = Awaited<ReturnType<typeof admin>>;
const adminFetch = (a: Admin, path: string, method = "GET", body?: unknown) =>
  fetchWith(
    path,
    {
      method,
      headers: a.user.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    a.bindings,
  );
async function create(a: Admin, value = input()) {
  const response = await adminFetch(a, "/api/admin/tournaments", "POST", value);
  expect(response.status).toBe(201);
  return tournamentRecordSchema.parse(await response.json());
}
async function publish(a: Admin, record: TournamentRecord) {
  const response = await adminFetch(a, `/api/admin/tournaments/${record.key}/publish`, "POST", {
    version: record.version,
  });
  expect(response.status).toBe(200);
  return tournamentRecordSchema.parse(await response.json());
}
async function read(a: Admin, key: string) {
  const response = await adminFetch(a, `/api/admin/tournaments/${key}`);
  expect(response.status).toBe(200);
  return tournamentRecordSchema.parse(await response.json());
}
const entry = (id: number, headers: Record<string, string>) =>
  fetchWith(`/api/tournaments/${id}/entries`, {
    method: "POST",
    headers: { ...headers, "X-Legal-Consent": legalVersion },
  });
const editInput = (record: TournamentRecord): TournamentInput => ({
  name: record.name,
  description: record.description,
  rulesDescription: record.rulesDescription,
  startsAtMs: record.startsAtMs,
  endsAtMs: record.endsAtMs,
});

beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM tournament_point_events"),
    env.APP_DB.prepare("DELETE FROM tournament_scores"),
    env.APP_DB.prepare("DELETE FROM tournament_match_players"),
    env.APP_DB.prepare("DELETE FROM tournament_matches"),
    env.APP_DB.prepare("DELETE FROM tournament_wait_reservations"),
    env.APP_DB.prepare("DELETE FROM tournament_entries"),
    env.APP_DB.prepare("DELETE FROM tournaments"),
  ]);
});

test("管理は既存の管理者認証・Origin・no-storeを使い、第三者の閲覧と更新を拒否する", async () => {
  const a = await admin(),
    outsider = await accountFixture();
  const anonymous = await fetchWith("/api/admin/tournaments", undefined, a.bindings);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
  expect(
    (await fetchWith("/api/admin/tournaments", { headers: outsider.headers }, a.bindings)).status,
  ).toBe(403);
  expect(
    (
      await fetchWith(
        "/api/admin/tournaments",
        { headers: a.user.headers },
        { ...a.bindings, ADMIN_ACCOUNT_IDS: "[]" },
      )
    ).status,
  ).toBe(503);
  for (const originHeader of ["https://example.test", ""]) {
    expect(
      (
        await fetchWith(
          "/api/admin/tournaments",
          {
            method: "POST",
            headers: { ...a.user.headers, Origin: originHeader },
            body: JSON.stringify(input()),
          },
          a.bindings,
        )
      ).status,
    ).toBe(403);
  }
  const draft = await create(a);
  for (const path of [
    `/api/admin/tournaments/${draft.key}`,
    `/api/admin/tournaments/${draft.key}/entries`,
  ]) {
    expect((await fetchWith(path, undefined, a.bindings)).status).toBe(401);
    expect((await fetchWith(path, { headers: outsider.headers }, a.bindings)).status).toBe(403);
  }
  for (const [path, method, body] of [
    [`/api/admin/tournaments/${draft.key}`, "PATCH", { ...input(), version: 1 }],
    [`/api/admin/tournaments/${draft.key}/publish`, "POST", { version: 1 }],
  ] as const) {
    expect(
      (
        await fetchWith(
          path,
          {
            method,
            headers: { ...a.user.headers, Origin: "https://example.test" },
            body: JSON.stringify(body),
          },
          a.bindings,
        )
      ).status,
    ).toBe(403);
  }
  const response = await adminFetch(a, `/api/admin/tournaments/${draft.key}`);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("下書きは非公開で、自由文・日時・版だけを保存して同時更新の片方を409にする", async () => {
  const a = await admin();
  const draft = await create(a, input({ startsAtMs: null, endsAtMs: null }));
  expect(draft).toMatchObject({
    id: null,
    published: false,
    version: 1,
    status: "draft",
    startsAtMs: null,
    endsAtMs: null,
  });
  expect(draft.description).toBe("初参加も歓迎します。\n途中参加できます。");
  expect((await fetchWith(`/api/tournaments/${draft.key}`)).status).toBe(404);
  expect((await fetchWith("/api/tournaments/1")).status).toBe(404);
  const lobby = tournamentLobbySchema.parse(
    await (await fetchWith("/api/tournaments/lobby")).json(),
  );
  expect(lobby.tournament).toBeNull();
  for (const invalid of [
    { name: " " },
    { name: "😀".repeat(81) },
    { description: "😀".repeat(2001) },
    { rulesDescription: "😀".repeat(2001) },
    { startsAtMs: 2000, endsAtMs: 1000 },
    { byoyomiMs: 1000 },
    { ruleVersion: 2 },
    { published: true },
  ]) {
    expect(
      (await adminFetch(a, "/api/admin/tournaments", "POST", { ...input(), ...invalid })).status,
    ).toBe(400);
  }
  expect(
    (await adminFetch(a, `/api/admin/tournaments/${draft.key}`, "PATCH", input())).status,
  ).toBe(400);
  const responses = await Promise.all(
    ["修正A", "修正B"].map((name) =>
      adminFetch(a, `/api/admin/tournaments/${draft.key}`, "PATCH", {
        ...input({ name }),
        version: 1,
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const changed = await read(a, draft.key);
  expect(changed.version).toBe(2);
  expect(changed.createdAtMs).toBe(draft.createdAtMs);
  expect(["修正A", "修正B"]).toContain(changed.name);
});

test("公開は未来日時を要求し、開催順の連番・非重複と一度だけの採番を保証する", async () => {
  const a = await admin();
  for (const overrides of [
    { startsAtMs: null, endsAtMs: null },
    { startsAtMs: Date.now() - 2000, endsAtMs: Date.now() - 1000 },
  ]) {
    const draft = await create(a, input(overrides));
    expect(
      (await adminFetch(a, `/api/admin/tournaments/${draft.key}/publish`, "POST", { version: 1 }))
        .status,
    ).toBe(400);
    expect((await read(a, draft.key)).id).toBeNull();
  }
  const draft = await create(a);
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      adminFetch(a, `/api/admin/tournaments/${draft.key}/publish`, "POST", { version: 1 }),
    ),
  );
  expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
  const first = await read(a, draft.key);
  expect(first).toMatchObject({
    id: 1,
    published: true,
    version: 2,
    status: "upcoming",
    ruleVersion: 1,
  });
  const overlap = await create(
    a,
    input({ startsAtMs: first.endsAtMs! - 1, endsAtMs: first.endsAtMs! + 10000 }),
  );
  expect(
    (await adminFetch(a, `/api/admin/tournaments/${overlap.key}/publish`, "POST", { version: 1 }))
      .status,
  ).toBe(400);
  const adjacent = await publish(
    a,
    await create(a, input({ startsAtMs: first.endsAtMs, endsAtMs: first.endsAtMs! + 10000 })),
  );
  expect(adjacent.id).toBe(2);
  const earlier = await create(
    a,
    input({ startsAtMs: first.startsAtMs! - 10000, endsAtMs: first.startsAtMs! - 1000 }),
  );
  expect(
    (await adminFetch(a, `/api/admin/tournaments/${earlier.key}/publish`, "POST", { version: 1 }))
      .status,
  ).toBe(400);
  expect((await read(a, overlap.key)).id).toBeNull();
  expect((await read(a, earlier.key)).id).toBeNull();
});

test("公開済み大会の日時・機械条件・公開状態は変更せず、表記修正にも版を要求する", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  for (const patch of [
    { startsAtMs: published.startsAtMs! + 1 },
    { endsAtMs: published.endsAtMs! + 1 },
    { startsAtMs: null },
    { rulesVersion: 2 },
    { published: false },
    { id: 99 },
    { pointsUnits: [0, 0, 0, 0] },
  ]) {
    expect(
      (
        await adminFetch(a, `/api/admin/tournaments/${published.key}`, "PATCH", {
          ...editInput(published),
          version: published.version,
          ...patch,
        })
      ).status,
    ).toBe(400);
  }
  expect((await read(a, published.key)).version).toBe(published.version);
  const update = await adminFetch(a, `/api/admin/tournaments/${published.key}`, "PATCH", {
    ...editInput(published),
    name: "表記修正版",
    description: "詳細を訂正",
    rulesDescription: "説明を訂正",
    version: published.version,
  });
  expect(update.status).toBe(200);
  const changed = tournamentRecordSchema.parse(await update.json());
  expect(changed).toMatchObject({
    id: published.id,
    version: 3,
    name: "表記修正版",
    startsAtMs: published.startsAtMs,
    endsAtMs: published.endsAtMs,
    published: true,
  });
  expect(
    (
      await adminFetch(a, `/api/admin/tournaments/${published.key}`, "PATCH", {
        ...editInput(changed),
        version: 2,
      })
    ).status,
  ).toBe(409);
  expect([404, 405]).toContain(
    (await adminFetch(a, `/api/admin/tournaments/${published.key}`, "DELETE")).status,
  );
});

test("別大会の同時公開も直列化して時間帯の重複と公開番号の競合を防ぐ", async () => {
  const a = await admin(),
    schedule = input();
  const drafts = await Promise.all([create(a, schedule), create(a, schedule)]);
  const results = await Promise.all(
    drafts.map((draft) =>
      adminFetch(a, `/api/admin/tournaments/${draft.key}/publish`, "POST", { version: 1 }),
    ),
  );
  expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  const records = await Promise.all(drafts.map((draft) => read(a, draft.key)));
  expect(records.map((record) => record.id).sort()).toEqual([1, null]);
  const next = await publish(
    a,
    await create(a, input({ startsAtMs: schedule.endsAtMs, endsAtMs: schedule.endsAtMs! + 1000 })),
  );
  expect(next.id).toBe(2);
});

test("公開詳細は未ログイン・設定前でも閲覧でき、エントリーは設定済み本人だけに許可する", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  const incomplete = await accountFixture(false),
    participant = await accountFixture();
  for (const headers of [undefined, incomplete.headers]) {
    const response = await fetchWith(`/api/tournaments/${published.id}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(tournamentDetailSchema.parse(await response.json()).tournament.id).toBe(1);
  }
  expect((await entry(1, { Origin: origin })).status).toBe(401);
  expect((await entry(1, incomplete.headers)).status).toBe(403);
  expect((await entry(1, { ...participant.headers, Origin: "https://example.test" })).status).toBe(
    403,
  );
  expect((await fetchWith("/api/tournaments/1/participation")).status).toBe(401);
  expect(
    (await fetchWith("/api/tournaments/1/participation", { headers: incomplete.headers })).status,
  ).toBe(403);
  const duplicates = await Promise.all(
    Array.from({ length: 4 }, () => entry(1, participant.headers)),
  );
  expect(
    await Promise.all(
      duplicates.map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ),
  ).toEqual(Array.from({ length: 4 }, () => ({ status: 200, body: { entered: true } })));
  expect((await read(a, published.key)).entryCount).toBe(1);
  expect(
    (await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_key=? AND account_id=?",
    )
      .bind(published.key, participant.id)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  await env.APP_DB.prepare("UPDATE tournaments SET starts_at_ms=?,ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 1000, Date.now() + 3600000, published.key)
    .run();
  expect((await entry(1, a.user.headers)).status).toBe(200);
  await env.APP_DB.prepare("UPDATE tournaments SET starts_at_ms=?,ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 2000, Date.now() - 1000, published.key)
    .run();
  expect((await entry(1, participant.headers)).status).toBe(409);
});

test("開催前の公開APIは名簿・本人戦績を返さず、公開情報に管理キーや認証情報を混ぜない", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  expect((await entry(1, a.user.headers)).status).toBe(200);
  for (const headers of [undefined, a.user.headers]) {
    const response = await fetchWith("/api/tournaments/1", { headers });
    const raw = await response.json();
    const detail = tournamentDetailSchema.parse(raw);
    expect(detail.tournament.entryCount).toBe(1);
    expect(detail.standings).toEqual([]);
    expect(detail.self).toBeNull();
    const standings = tournamentStandingsSchema.parse(
      await (await fetchWith("/api/tournaments/1/standings?all=1", { headers })).json(),
    );
    expect(standings).toEqual({ standings: [], self: null, nextCursor: null });
    const json = JSON.stringify(raw);
    for (const secret of [
      published.key,
      a.user.id,
      a.user.token,
      "@example.test",
      "accountId",
      "tokenHash",
      "version",
    ])
      expect(json).not.toContain(secret);
  }
});

test("大会エントリーは規約と年齢条件の現行版確認を要求し、同意と本人のエントリーを記録する", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  const participant = await accountFixture();
  await env.APP_DB.prepare("DELETE FROM legal_consents WHERE account_id=?")
    .bind(participant.id)
    .run();
  for (const version of [null, "2026-01-01"]) {
    const response = await fetchWith("/api/tournaments/1/entries", {
      method: "POST",
      headers: { ...participant.headers, ...(version ? { "X-Legal-Consent": version } : {}) },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      message: "利用規約と年齢条件を確認してください。",
    });
    expect((await read(a, published.key)).entryCount).toBe(0);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM legal_consents WHERE account_id=?")
        .bind(participant.id)
        .first(),
    ).toBeNull();
  }
  const before = Date.now();
  expect((await entry(1, participant.headers)).status).toBe(200);
  const consent = await env.APP_DB.prepare(
    "SELECT version,accepted_at_ms FROM legal_consents WHERE account_id=?",
  )
    .bind(participant.id)
    .first<{ version: string; accepted_at_ms: number }>();
  expect(consent?.version).toBe(legalVersion);
  expect(consent!.accepted_at_ms).toBeGreaterThanOrEqual(before);
  expect(consent!.accepted_at_ms).toBeLessThanOrEqual(Date.now());
  expect((await read(a, published.key)).entryCount).toBe(1);
  const status = await fetchWith("/api/tournaments/1/participation", {
    headers: participant.headers,
  });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ entered: true, status: "idle" });
});

test("管理大会一覧を50件ずつ重複なく取得し、不正カーソルを拒否する", async () => {
  const a = await admin(),
    now = Date.now();
  await env.APP_DB.batch(
    Array.from({ length: 55 }, (_, i) =>
      env.APP_DB.prepare(
        "INSERT INTO tournaments(key,name,description,rules_description,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms) VALUES(?,?, '', '', ?, ?, ?, ?)",
      ).bind(
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        `大会${i}`,
        now + (Math.floor(i / 2) + 1) * 10000,
        now + (Math.floor(i / 2) + 2) * 10000,
        now + (55 - i) * 1000,
        now,
      ),
    ),
  );
  const first = tournamentAdminListSchema.parse(
    await (await adminFetch(a, "/api/admin/tournaments")).json(),
  );
  expect(first.tournaments).toHaveLength(50);
  expect(first.tournaments.slice(0, 5).map((row) => row.name)).toEqual([
    "大会54",
    "大会53",
    "大会52",
    "大会51",
    "大会50",
  ]);
  expect(first.nextCursor).not.toBeNull();
  const second = tournamentAdminListSchema.parse(
    await (
      await adminFetch(a, `/api/admin/tournaments?cursor=${encodeURIComponent(first.nextCursor!)}`)
    ).json(),
  );
  expect(second.tournaments).toHaveLength(5);
  expect(second.tournaments.map((row) => row.name)).toEqual([
    "大会4",
    "大会3",
    "大会2",
    "大会1",
    "大会0",
  ]);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.tournaments, ...second.tournaments].map((tournament) => tournament.key)).size,
  ).toBe(55);
  expect((await adminFetch(a, "/api/admin/tournaments?cursor=invalid")).status).toBe(400);
});

test("管理名簿は未対局者も全員表示し、現在の名前・公開IDで検索して50件ずつ取得する", async () => {
  const a = await admin(),
    published = await publish(a, await create(a)),
    now = Date.now();
  const prefix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const users = Array.from({ length: 55 }, (_, i) => ({
    id: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    username: `t_${prefix}_${String(i).padStart(2, "0")}`,
    name: `参加者${String(i).padStart(2, "0")}`,
  }));
  await env.APP_DB.batch(
    users.flatMap((user, i) => [
      env.APP_DB.prepare(
        "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,username,profileCompleted) VALUES(?,?,?,1,?,?,?,1)",
      ).bind(user.id, user.name, `${user.id}@example.test`, now, now, user.username),
      env.APP_DB.prepare(
        "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
      ).bind(user.entryId, published.key, user.id, now + i),
    ]),
  );
  const response = await adminFetch(a, `/api/admin/tournaments/${published.key}/entries`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const first = tournamentAdminEntriesSchema.parse(await response.json());
  expect(first.total).toBe(55);
  expect(first.entries).toHaveLength(50);
  expect(first.entries[0]).toMatchObject({
    name: "参加者00",
    status: "idle",
    games: 0,
    pointsUnits: 0,
    rank: null,
  });
  const second = tournamentAdminEntriesSchema.parse(
    await (
      await adminFetch(
        a,
        `/api/admin/tournaments/${published.key}/entries?cursor=${encodeURIComponent(first.nextCursor!)}`,
      )
    ).json(),
  );
  expect(second.entries).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(second.total).toBe(55);
  expect(new Set([...first.entries, ...second.entries].map((row) => row.username)).size).toBe(55);
  await env.APP_DB.prepare("UPDATE user SET name=? WHERE id=?")
    .bind("現在の名前", users[0]!.id)
    .run();
  for (const query of ["現在の名前", users[0]!.username, `@${users[0]!.username}`]) {
    const result = tournamentAdminEntriesSchema.parse(
      await (
        await adminFetch(
          a,
          `/api/admin/tournaments/${published.key}/entries?search=${encodeURIComponent(query)}`,
        )
      ).json(),
    );
    expect({ query, total: result.total }).toEqual({ query, total: 1 });
    expect(result.entries[0]?.name).toBe("現在の名前");
  }
  for (const query of ["%", "存在しない名前"]) {
    const result = tournamentAdminEntriesSchema.parse(
      await (
        await adminFetch(
          a,
          `/api/admin/tournaments/${published.key}/entries?search=${encodeURIComponent(query)}`,
        )
      ).json(),
    );
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  }
  const serialized = JSON.stringify(first);
  for (const user of users) expect(serialized).not.toContain(user.id);
  expect(serialized).not.toContain("@example.test");
  expect(
    (await adminFetch(a, `/api/admin/tournaments/${published.key}/entries?cursor=bad`)).status,
  ).toBe(400);
});

test("開催前・開催中・確定後の公開詳細はマッチングDOが利用できなくてもD1から返す", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  const bindings = {
    ...env,
    TOURNAMENT_COORDINATOR: {
      getByName() {
        throw new Error("Matching coordinator unavailable");
      },
    } as unknown as Env["TOURNAMENT_COORDINATOR"],
  };
  for (const status of ["upcoming", "active", "finished"] as const) {
    const now = Date.now();
    await env.APP_DB.prepare(
      "UPDATE tournaments SET starts_at_ms=?,ends_at_ms=?,finalized_at_ms=? WHERE key=?",
    )
      .bind(
        status === "upcoming" ? now + 1000 : now - 2000,
        status === "finished" ? now - 1000 : now + 2000,
        status === "finished" ? now : null,
        published.key,
      )
      .run();
    const response = await fetchWith("/api/tournaments/1", undefined, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(tournamentDetailSchema.parse(await response.json()).tournament.status).toBe(status);
  }
});

test("終了後の復旧が失敗しても大会詳細とロビーは取得でき、復旧を背景処理へ渡す", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  await env.APP_DB.prepare("UPDATE tournaments SET starts_at_ms=?,ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 2000, Date.now() - 1000, published.key)
    .run();
  const pending: Promise<unknown>[] = [];
  const bindings = {
    ...env,
    TOURNAMENT_COORDINATOR: {
      getByName() {
        return {
          refresh: async () => {
            throw new Error("Recovery unavailable");
          },
        };
      },
    } as unknown as Env["TOURNAMENT_COORDINATOR"],
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  const detailResponse = await worker.fetch(
    new Request(origin + "/api/tournaments/1"),
    bindings,
    context,
  );
  expect(detailResponse.status).toBe(200);
  expect(tournamentDetailSchema.parse(await detailResponse.json()).tournament.status).toBe(
    "settling",
  );
  const lobbyResponse = await worker.fetch(
    new Request(origin + "/api/tournaments/lobby"),
    bindings,
    context,
  );
  expect(lobbyResponse.status).toBe(200);
  expect(tournamentLobbySchema.parse(await lobbyResponse.json()).tournament?.status).toBe(
    "settling",
  );
  expect(pending).toHaveLength(2);
  await Promise.all(pending);
});
