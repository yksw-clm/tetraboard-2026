import { afterAll, beforeAll, expect, test } from "bun:test";
import { checkProbe, deploymentProbes } from "../scripts/deploymentChecks";
import {
  applyAction,
  createInitialState,
  getCheckState,
  getLegalActions,
  sides,
  type FourShogiAction,
  type FourShogiState,
} from "../../four-shogi/src/index";
import { applyReplayEvent, type FourShogiReplayEvent } from "../../four-shogi/src/replay";

const token = "test-ai-service-token-at-least-32-characters";
let server: ReturnType<typeof Bun.spawn>;
let baseUrl = "";
const aiDirectory = new URL("..", import.meta.url).pathname;
beforeAll(async () => {
  server = Bun.spawn(
    ["cargo", "run", "--release", "--quiet", "--locked", "-p", "tetraboard-ai-server"],
    {
      cwd: aiDirectory,
      env: {
        ...process.env,
        AI_SERVICE_TOKEN: token,
        AI_SERVICE_LISTEN: "127.0.0.1:0",
        AI_SERVICE_CONCURRENCY: "4",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done)
      throw Error(
        `AI Service did not start: ${await new Response(server.stderr as ReadableStream).text()}`,
      );
    text += new TextDecoder().decode(value);
    if (text.includes("\n")) break;
  }
  reader.releaseLock();
  baseUrl = `http://${JSON.parse(text.split("\n")[0]).listen}`;
}, 30000);
afterAll(async () => {
  server?.kill("SIGTERM");
  if (server) await server.exited;
});

test("実HTTPのhealthと認証境界を確認する", async () => {
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  expect(
    (
      await fetch(`${baseUrl}/v1/move`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(401);
});

test("公開確認用の全四人ゲームprofileが実Rust Serviceの合法手と版に一致する", async () => {
  for (const probe of deploymentProbes().filter((p) => p.game.startsWith("four-")))
    await checkProbe(baseUrl, token, probe, 5000);
});

type FourShogiReplay = {
  events: FourShogiReplayEvent[];
  reason: "last_player" | "repetition";
  ranks: number[];
};

async function fourShogiReplays(): Promise<FourShogiReplay[]> {
  const fixtures = Bun.file(new URL("../fixtures/four-shogi-lv3-v1.jsonl", import.meta.url));
  return (await fixtures.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function fourShogiInitialState() {
  return createInitialState({
    mode: "singles",
    players: { south: "S", west: "W", north: "N", east: "E" },
    threePlayerAttackProhibited: true,
  });
}

function replayFourShogiEvent(state: FourShogiState, event: FourShogiReplayEvent) {
  const applied = applyReplayEvent(state, event);
  if (!applied.ok) throw new Error(`棋譜を再生できません: ${JSON.stringify(event)}`);
  return applied.state;
}

test("四人将棋の代表棋譜を両エンジンで再生し、全局面の合法手と終局順位を照合する", async () => {
  const coverage = new Set<string>();
  const cases = (await fourShogiReplays()).map((replay) => {
    let state = fourShogiInitialState();
    const checkpoints = replay.events.map((event, index) => {
      const { turn } = state;
      if (turn === null) throw new Error("棋譜の途中で終局しました");
      const actions = getLegalActions(state);
      if (getCheckState(state)[turn]) coverage.add("check");
      if (getLegalActions({ ...state, threePlayerAttackProhibited: false }).length > actions.length)
        coverage.add("three_player_attack");
      if (event.type === "action") {
        if (event.action.type === "dropPiece") coverage.add("drop");
        if (event.action.type === "movePiece" && event.action.promote) coverage.add("promotion");
      }
      if (state.eliminations.some((entry) => entry.reason === "checkmate"))
        coverage.add("after_checkmate");
      if (event.type === "eliminate" && event.reason === "timeout") coverage.add("timeout");
      const ranks = sides.map(
        (side) => state.eliminations.find((entry) => entry.side === side)?.rank ?? 0,
      );
      state = replayFourShogiEvent(state, event);
      return { index, turn, actions, ranks };
    });
    if (state.result?.mode !== "singles") throw new Error("シングルスの終局棋譜が必要です");
    const { reason, standings } = state.result;
    const ranks = sides.map((side) => standings.find((entry) => entry.side === side)?.rank);
    expect(reason).toBe(replay.reason);
    expect(ranks).toEqual(replay.ranks);
    coverage.add(reason);
    return JSON.stringify({ restricted: true, events: replay.events, checkpoints, reason, ranks });
  });
  expect(coverage).toEqual(
    new Set([
      "check",
      "three_player_attack",
      "drop",
      "promotion",
      "after_checkmate",
      "timeout",
      "last_player",
      "repetition",
    ]),
  );
  const compared = Bun.spawnSync(
    [
      "cargo",
      "run",
      "--release",
      "--quiet",
      "--locked",
      "-p",
      "tetraboard-ai-agents",
      "--example",
      "four_shogi_parity",
    ],
    { cwd: aiDirectory, stdin: Buffer.from(`${cases.join("\n")}\n`), stderr: "pipe" },
  );
  expect(compared.stderr.toString()).toBe("");
  expect(compared.exitCode).toBe(0);
}, 30000);

test("四人将棋の実AI Serviceが3設定の上限を守り、棋譜に対する合法手を返す", async () => {
  const [replay] = await fourShogiReplays();
  const events = replay.events.slice(0, 16);
  const state = events.reduce(replayFourShogiEvent, fourShogiInitialState());
  if (state.turn === null) throw new Error("探索を開始できる局面が必要です");
  const request = {
    api_version: 1,
    rules_version: 1,
    request_id: crypto.randomUUID(),
    position_revision: "ab".repeat(32),
    profile_id: "four-shogi-lv3-work4096-v1",
    three_player_attack_prohibited: true,
    turn: state.turn,
    events,
  };
  function post(body: unknown, authenticated = true, padding = 0) {
    return fetch(`${baseUrl}/v1/four-shogi/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body) + " ".repeat(padding),
    });
  }
  for (const maxWork of [4096, 16384, 65536]) {
    const profileId = `four-shogi-lv3-work${maxWork}-v1`;
    // 棋譜用のサイズ上限が共通の16KiBより優先されることも実HTTPで確認します。
    const response = await post({ ...request, profile_id: profileId }, true, 16 * 1024);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      action: FourShogiAction;
      diagnostics: { work: number };
    };
    expect(body).toMatchObject({
      request_id: request.request_id,
      position_revision: request.position_revision,
      engine_version: "four-shogi-lv3-v1",
      profile_id: profileId,
      max_work: maxWork,
      max_time_ms: 500,
    });
    expect(body.diagnostics.work).toBeGreaterThan(0);
    expect(body.diagnostics.work).toBeLessThanOrEqual(maxWork);
    expect(applyAction(state, state.turn, body.action).ok).toBe(true);
  }

  expect((await post(request, false)).status).toBe(401);
  expect((await post(request, true, 256 * 1024)).status).toBe(413);
  for (const invalid of [
    { ...request, profile_id: "rank_trial" },
    { ...request, max_work: 65536 },
    { ...request, turn: sides.find((side) => side !== state.turn) },
    { ...request, events: [{ ...events[0], side: "north" }, ...events.slice(1)] },
    { ...request, events: replay.events },
  ]) {
    expect((await post(invalid)).status).toBe(400);
  }
});

const workerDirectory = new URL("../../../apps/worker", import.meta.url).pathname;
const workerSuites = [
  ...new Bun.Glob("test-ai-service/**/*.test.ts").scanSync({ cwd: workerDirectory }),
].sort();

test("実AI Serviceへ接続するWorkerの統合試験が存在する", () => {
  expect(workerSuites.length).toBeGreaterThan(0);
});

test.each(workerSuites)(
  "実AI ServiceとWorkerの統合試験 %s",
  async (suite) => {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "test",
        "--config",
        "vitest.ai-service.config.mts",
        "--reporter=verbose",
        suite,
      ],
      {
        cwd: workerDirectory,
        env: {
          ...process.env,
          TETRABOARD_AI_TEST_URL: baseUrl,
          TETRABOARD_AI_TEST_TOKEN: token,
          TETRABOARD_AI_TEST_WARMUP: suite.endsWith("/ratedAiWarmup.test.ts") ? "1" : "0",
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    try {
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  },
  30000,
);
