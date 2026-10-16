import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { shogiArchives } from "../../../test-fixtures/matches";
import { accountFixture, origin } from "./accountFixtures";
import { fourShogiAiRoutes } from "../src/fourShogiAi/routes";
import { aiPrincipal, type AiGatewayEnv } from "../src/fourShogiAi/client";
import { aiRequestFingerprint, type AiJobRequest } from "@tetraboard/protocol/four-shogi-ai";

const secret = "ai-test-only-server-secret-at-least-32-characters";
const code = "a".repeat(40),
  model = "four-shogi-tiny-policy-value-v1:" + "b".repeat(64);
const instance = "00000000-0000-4000-8000-000000000099";
const health = {
  schemaVersion: 1,
  serviceInstanceId: instance,
  requestWindow: 0,
  codeVersion: code,
  engineVersion: "tetraboard-four-shogi-rules-v1",
  modelId: model,
  status: "ready",
  workers: 2,
  running: 0,
  queued: 0,
  cpuReserved: 1,
  memory: { observedBytes: 100, peakBytes: 100, limitBytes: 939524096 },
};
const settings = (id: string): AiGatewayEnv => ({
  ...env,
  FOUR_SHOGI_AI_ACCOUNT_IDS: JSON.stringify([id]),
  FOUR_SHOGI_AI_URL: "https://ai.test",
  FOUR_SHOGI_AI_SHARED_SECRET: secret,
  FOUR_SHOGI_AI_MODEL_ID: model,
  FOUR_SHOGI_AI_CODE_VERSION: code,
});
const call = (e: AiGatewayEnv, path: string, init?: RequestInit) =>
  fourShogiAiRoutes.fetch(new Request(origin + "/four-shogi-ai" + path, init), e);
const matches: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of matches.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM shogi_match_chunks WHERE match_id=?").bind(id).run();
    await env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id).run();
  }
});
test("試用設定がない・本番・未認証・許可外・CSRFの解析要求を拒否する", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const configured = settings(user.id);
  expect((await call(env, "/health")).status).toBe(503);
  expect((await call(configured, "/health")).status).toBe(401);
  expect((await call(configured, "/health", { headers: { Cookie: other.cookie } })).status).toBe(
    403,
  );
  expect(
    (
      await call({ ...configured, APP_ORIGIN: "https://tetraboard.net" }, "/health", {
        headers: { Cookie: user.cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(configured, "/jobs", {
        method: "POST",
        headers: { ...user.headers, Origin: "https://other.test" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});
test("許可ユーザーだけがhealthを読め、Cookie・本人ID・共有秘密を応答や転送本文へ含めない", async () => {
  const user = await accountFixture(),
    configured = settings(user.id);
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(health));
  const response = await call(configured, "/health", { headers: { Cookie: user.cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  for (const value of [secret, user.id, user.cookie]) expect(body).not.toContain(value);
  const options = spy.mock.calls[0][1]!;
  const headers = new Headers(options.headers);
  expect(headers.get("authorization")).toBe("Bearer " + secret);
  expect(headers.get("cookie")).toBeNull();
  expect(options.redirect).toBe("manual");
  expect(await aiPrincipal(configured, user.id)).toMatch(/^[0-9a-f]{64}$/);
  expect(await aiPrincipal(configured, user.id)).not.toBe(
    await aiPrincipal(configured, "another-account"),
  );
});
test("保存済みシングルス棋譜だけを方向IDへ置換し、固定予算と利用者識別をサーバーで付ける", async () => {
  const user = await accountFixture(),
    configured = settings(user.id);
  const fixture = shogiArchives.find((f) => f.name === "shogi-singles")!;
  const matchId = crypto.randomUUID();
  matches.push(matchId);
  const record = JSON.parse(
    fixture.recordJson.replaceAll(fixture.detail.id, matchId).replaceAll("fixture-self", user.id),
  );
  await env.APP_DB.prepare(
    "INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      matchId,
      "four-shogi",
      "singles",
      record.startedAtMs,
      record.endedAtMs,
      JSON.stringify(record),
    )
    .run();
  for (let cursor = 0; cursor < fixture.events.length; cursor += 100) {
    const chunk = fixture.events.slice(cursor, cursor + 100).map((e) => e.event);
    await env.APP_DB.prepare(
      "INSERT INTO shogi_match_chunks (match_id,chunk_index,start_index,event_count,events_json) VALUES (?,?,?,?,?)",
    )
      .bind(matchId, cursor / 100, cursor, chunk.length, JSON.stringify(chunk))
      .run();
  }
  let forwarded: AiJobRequest | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const r = JSON.parse(String(init!.body)) as AiJobRequest;
    forwarded = r;
    return Response.json(
      {
        schemaVersion: 1,
        serviceInstanceId: r.serviceInstanceId,
        jobId: crypto.randomUUID(),
        requestId: r.requestId,
        stateHash: r.stateHash,
        inputHash: await aiRequestFingerprint(r),
        codeVersion: r.codeVersion,
        engineVersion: r.engineVersion,
        modelId: r.modelId,
        context: r.context,
        status: "queued",
        error: null,
        timing: { queueMs: 0, computeMs: 0, restoreMs: 0, searchMs: 0, inferenceMs: 0 },
        result: null,
      },
      { status: 202 },
    );
  });
  const input = {
    schemaVersion: 1,
    serviceInstanceId: instance,
    requestId: "0:" + crypto.randomUUID(),
    matchId,
    eventOffset: 1,
    stateHash: "c".repeat(64),
    profile: "trial-500ms",
  };
  const response = await call(configured, "/jobs", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(202);
  expect(forwarded).toMatchObject({
    budget: { timeBudgetMs: 500, maxWork: 1000000 },
    includeAction:
      fixture.events[1].event.type === "action" ? fixture.events[1].event.action : null,
    modelId: model,
    position: {
      initial: { players: { south: "south", west: "west", north: "north", east: "east" } },
      eventOffset: 1,
      events: [fixture.events[0]],
    },
  });
  for (const eventOffset of [0, 99, 100, 103]) {
    const pageResponse = await call(configured, "/jobs", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ ...input, requestId: "0:" + crypto.randomUUID(), eventOffset }),
    });
    expect(pageResponse.status).toBe(202);
    expect(forwarded).toMatchObject({
      includeAction:
        fixture.events[eventOffset]?.event.type === "action"
          ? fixture.events[eventOffset].event.action
          : null,
      position: { eventOffset, events: fixture.events.slice(0, eventOffset) },
    });
  }
  const wire = JSON.stringify(forwarded);
  for (const value of [secret, user.id, user.cookie, "accountId", "fixture-self"])
    expect(wire).not.toContain(value);
  expect(
    (
      await call(configured, "/jobs", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ ...input, purpose: "cpu", command: "evil" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(configured, "/jobs", {
        method: "POST",
        headers: user.headers,
        body: "x".repeat(2049),
      })
    ).status,
  ).toBe(413);
});
test("サービス側の使用量制限を伝え、不一致の版や結果を採用しない", async () => {
  const user = await accountFixture(),
    configured = settings(user.id);
  const jobId = crypto.randomUUID(),
    path = `/jobs/${jobId}?serviceInstanceId=${instance}`;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ error: "usage_limit" }, { status: 429, headers: { "Retry-After": "17" } }),
    );
  const limited = await call(configured, path, { headers: { Cookie: user.cookie } });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("17");
  spy.mockResolvedValue(Response.json({ ...health, codeVersion: "d".repeat(40) }));
  expect((await call(configured, "/health", { headers: { Cookie: user.cookie } })).status).toBe(
    503,
  );
  spy.mockResolvedValue(Response.json({ error: "secret:" + secret }, { status: 500 }));
  const error = await call(configured, path, { headers: { Cookie: user.cookie } });
  expect(error.status).toBe(503);
  expect(await error.text()).not.toContain(secret);
});
test("利用者向け取消は用途を先に検査し、CPUジョブへ取消を転送しない", async () => {
  const user = await accountFixture(),
    configured = settings(user.id),
    jobId = crypto.randomUUID();
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      schemaVersion: 1,
      serviceInstanceId: instance,
      jobId,
      requestId: "0:" + crypto.randomUUID(),
      stateHash: "c".repeat(64),
      inputHash: "d".repeat(64),
      codeVersion: code,
      engineVersion: health.engineVersion,
      modelId: model,
      context: {
        kind: "cpu",
        roomId: "trial",
        matchId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        revision: 1,
        side: "south",
        deadlineAtMs: Date.now() + 5000,
      },
      status: "running",
      error: null,
      timing: { queueMs: 0, computeMs: 0, restoreMs: 0, searchMs: 0, inferenceMs: 0 },
      result: null,
    }),
  );
  expect(
    (
      await call(configured, `/jobs/${jobId}?serviceInstanceId=${instance}`, {
        method: "DELETE",
        headers: user.headers,
      })
    ).status,
  ).toBe(404);
  expect(spy.mock.calls.map((c) => c[1]?.method)).toEqual(["GET"]);
});

test("VPSのリダイレクトは追従せず共有秘密を別の宛先へ転送しない", async () => {
  const user = await accountFixture(),
    configured = settings(user.id);
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: "https://another-origin.test/private" },
    }),
  );
  const response = await call(configured, "/health", { headers: { Cookie: user.cookie } });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "ai_redirect" });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0]).toBe("https://ai.test/v1/health");
  expect(spy.mock.calls[0][1]?.redirect).toBe("manual");
});

for (const prohibited of [true, false])
  for (const profile of ["trial-500ms", "trial-30000ms"] as const)
    test.skipIf(!(env as unknown as Record<string, string>).AI_CPU_SMOKE_URL)(
      `実モデル解析 ON/OFF=${prohibited} ${profile}: 保存終局棋譜→Worker→Linux探索→画面用PV照合`,
      async (context) => {
        const { analysisFixture } = await import("../../web/test/fixtures/fourShogiAnalysis");
        const { replayAnalysisRoot, readReplayAnalysis } =
          await import("../../web/src/features/room/fourShogiAnalysis");
        const fixture = analysisFixture(prohibited);
        const user = await accountFixture();
        const vars = env as unknown as Record<string, string>;
        const configured = {
          ...settings(user.id),
          FOUR_SHOGI_AI_URL: vars.AI_CPU_SMOKE_URL,
          FOUR_SHOGI_AI_SHARED_SECRET: vars.AI_CPU_SMOKE_SECRET,
          FOUR_SHOGI_AI_CODE_VERSION: vars.AI_CPU_SMOKE_CODE_VERSION,
          FOUR_SHOGI_AI_MODEL_ID: vars.AI_CPU_SMOKE_MODEL_ID,
        };
        const record = JSON.parse(
          shogiArchives.find((f) => f.name === "shogi-singles-draw")!.recordJson,
        );
        const matchId = crypto.randomUUID();
        matches.push(matchId);
        fixture.match.id = matchId;
        record.id = matchId;
        record.game = fixture.match.game;
        record.replay = fixture.match.replay;
        record.settings = fixture.match.settings;
        await env.APP_DB.prepare(
          "INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,?,?,?,?,?)",
        )
          .bind(
            matchId,
            "four-shogi",
            "singles",
            record.startedAtMs,
            record.endedAtMs,
            JSON.stringify(record),
          )
          .run();
        await env.APP_DB.prepare(
          "INSERT INTO shogi_match_chunks (match_id,chunk_index,start_index,event_count,events_json) VALUES (?,0,0,?,?)",
        )
          .bind(matchId, fixture.events.length, JSON.stringify(fixture.events))
          .run();
        const before = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
          .bind(matchId)
          .first();
        const healthResponse = await call(configured, "/health", {
          headers: { Cookie: user.cookie },
        });
        expect(healthResponse.status).toBe(200);
        const current = (await healthResponse.json()) as typeof health;
        const root = await replayAnalysisRoot(fixture.match, fixture.frames, 0);
        const submitted = await call(configured, "/jobs", {
          method: "POST",
          headers: user.headers,
          body: JSON.stringify({
            schemaVersion: 1,
            serviceInstanceId: current.serviceInstanceId,
            requestId: current.requestWindow + ":" + crypto.randomUUID(),
            matchId,
            eventOffset: 0,
            stateHash: root.position.stateHash,
            profile,
          }),
        });
        expect(submitted.status).toBe(202);
        let job =
          (await submitted.json()) as import("@tetraboard/protocol/four-shogi-ai").AiJobSnapshot;
        await vi.waitFor(
          async () => {
            const response = await call(
              configured,
              `/jobs/${job.jobId}?serviceInstanceId=${job.serviceInstanceId}`,
              { headers: { Cookie: user.cookie } },
            );
            expect(response.status).toBe(200);
            job = (await response.json()) as typeof job;
            expect(["completed", "failed", "expired"]).toContain(job.status);
          },
          { interval: 50, timeout: 45000 },
        );
        expect(job.status).toBe("completed");
        const view = readReplayAnalysis(job.result, root, {
          modelId: configured.FOUR_SHOGI_AI_MODEL_ID,
          codeVersion: configured.FOUR_SHOGI_AI_CODE_VERSION,
          profile,
        });
        expect(view.actual?.candidate.action).toEqual(root.actual);
        expect(view.candidates.length).toBeGreaterThanOrEqual(2);
        expect(view.result.model.usedModelId).toBe(configured.FOUR_SHOGI_AI_MODEL_ID);
        expect(view.result.model.inferenceCount).toBeGreaterThan(0);
        expect(
          await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
            .bind(matchId)
            .first(),
        ).toEqual(before);
        await context.annotate(
          JSON.stringify({
            prohibited,
            profile,
            eventOffset: 0,
            actualCompared: !!view.actual,
            candidateCount: view.candidates.length,
            completedDepth: view.result.diagnostics.completedDepth,
            model: view.result.model,
            timing: job.timing,
            stopReason: view.result.diagnostics.stopReason,
            work: view.result.diagnostics.work,
          }),
          "ai-analysis-model",
        );
      },
      60000,
    );
