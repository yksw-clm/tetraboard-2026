import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  tournamentDetailSchema,
  tournamentLobbySchema,
  tournamentLobbySectionsSchema,
  tournamentStandingsSchema,
} from "@tetraboard/protocol";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import {
  useTournamentApiFixtures,
  fetchWith,
  admin,
  create,
  publish,
  read,
  entry,
} from "./tournamentApiFixtures";

useTournamentApiFixtures();

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

test("大会詳細と全順位は指定時だけ公開プロフィールIDを返し、旧Webへの応答を維持する", async () => {
  const a = await admin(),
    published = await publish(a, await create(a));
  const publicId = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET publicProfileId=? WHERE id=?")
    .bind(publicId, a.user.id)
    .run();
  expect((await entry(1, a.user.headers)).status).toBe(200);
  await env.APP_DB.prepare("UPDATE tournaments SET starts_at_ms=?,ends_at_ms=? WHERE key=?")
    .bind(Date.now() - 1000, Date.now() + 3600000, published.key)
    .run();
  for (const path of ["/api/tournaments/1", "/api/tournaments/1/standings?all=1"]) {
    const schema = path.includes("/standings") ? tournamentStandingsSchema : tournamentDetailSchema;
    const previous = schema.parse(
      await (await fetchWith(path, { headers: a.user.headers })).json(),
    );
    expect(previous.self).not.toHaveProperty("profileId");
    for (const standing of previous.standings) expect(standing).not.toHaveProperty("profileId");
    const next = schema.parse(
      await (
        await fetchWith(`${path}${path.includes("?") ? "&" : "?"}includeProfiles=1`, {
          headers: a.user.headers,
        })
      ).json(),
    );
    expect(next.self?.profileId).toBe(publicId);
    expect(JSON.stringify(next)).not.toContain(a.user.id);
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
  const sectionsResponse = await worker.fetch(
    new Request(origin + "/api/tournaments/lobby?view=sections&game=four-shogi"),
    bindings,
    context,
  );
  expect(sectionsResponse.status).toBe(200);
  expect(
    tournamentLobbySectionsSchema.parse(await sectionsResponse.json()).current[0]?.status,
  ).toBe("settling");
  expect(pending).toHaveLength(3);
  await Promise.all(pending);
});
