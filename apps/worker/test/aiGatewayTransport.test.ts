import { createInitialState } from "@tetraboard/four-reversi";
import { fourReversiStateSchema } from "@tetraboard/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { namedCpuProfile } from "../src/matchmaking/cpuProfiles";
import {
  aiServiceConfigured,
  aiServiceEnabled,
  requestAiMove,
  requestRatedAiWarmup,
  requestFourShogiAiMove,
  requestReversiAiMove,
  requestShogiAiMove,
  type AiServiceBindings,
} from "../src/rooms/aiService";

const token = "test-ai-service-token-at-least-32-characters";
const enabled = {
  AI_SERVICE_TOKEN: token,
  AI_SHOGI_ENABLED: "true",
  AI_REVERSI_ENABLED: "true",
};
const nextJob = () => ({
  requestId: crypto.randomUUID(),
  roundId: crypto.randomUUID(),
  expiresAt: Date.now() + 30_000,
  positionRevision: 0,
});
const position = { x: 2, y: 3 };
const action = { type: "movePiece", from: { x: 4, y: 7 }, to: { x: 4, y: 6 }, promote: false };
const fourReversi = namedCpuProfile("lv1-v1");
const fourShogi = {
  profileId: "four-shogi-lv3-work16384-v1",
  engineVersion: "four-shogi-lv3-v1",
  name: "CPU（標準）",
  work: 16384,
  mu: 25,
  sigma: 1,
};

function fourReversiMove(bindings: AiServiceBindings, rated: boolean) {
  const game = fourReversiStateSchema.parse(createInitialState("singles"));
  if (game.status !== "playing") throw new Error("Expected initial playing state");
  return requestAiMove(bindings, {
    job: {
      ...nextJob(),
      instanceId: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      color: "black",
      level: 1,
      turnStartedAt: Date.now(),
      positionKey: "initial",
      ...(rated
        ? {
            extendedRules: true,
            serviceProfile: { profile_id: "lv1-v1", profile_hash: fourReversi.hash },
          }
        : {}),
    },
    game,
  });
}
const shogiMove = (bindings: AiServiceBindings) =>
  requestShogiAiMove(bindings, { job: nextJob(), moves: [], nodes: 256 });

const fourReversiReply = {
  game_id: "four-reversi",
  agent_id: "four-reversi-random-v1",
  engine_version: "0.2.0",
  position,
  diagnostics: { nodes: 0, completed_depth: 0, interrupted: false },
};
const moves = [
  {
    path: "/v2/move",
    move: (bindings: AiServiceBindings) => fourReversiMove(bindings, true),
    response: {
      ...fourReversiReply,
      api_version: 2,
      ruleset_version: "four-reversi-singles-v2",
      state_version: 2,
      profile_id: "lv1-v1",
      profile_hash: fourReversi.hash,
      effective_limits: null,
      reproducible: true,
    },
    result: { position },
  },
  {
    path: "/v1/move",
    move: (bindings: AiServiceBindings) => fourReversiMove(bindings, false),
    response: {
      ...fourReversiReply,
      api_version: 1,
      ruleset_version: "four-reversi-singles-v1",
      state_version: 1,
    },
    result: { position },
  },
  {
    path: "/v1/four-shogi/move",
    move: (bindings: AiServiceBindings) =>
      requestFourShogiAiMove(bindings, {
        job: { ...nextJob(), side: "south" },
        events: [],
        profile: fourShogi,
      }),
    response: {
      api_version: 1,
      rules_version: 1,
      profile_id: fourShogi.profileId,
      engine_version: fourShogi.engineVersion,
      max_work: fourShogi.work,
      max_time_ms: 500,
      diagnostics: { work: 100 },
      action,
    },
    result: { action },
  },
  {
    path: "/v1/reversi/move",
    move: (bindings: AiServiceBindings) =>
      requestReversiAiMove(bindings, {
        job: { ...nextJob(), moveNumber: 0 },
        board: "---------------------------WB------BW---------------------------",
        blackToMove: true,
        level: 4,
      }),
    response: { engine_version: "egaroucid-console-7.8.2-0c1b84ef", level: 4, position },
    result: position,
  },
  {
    path: "/v1/shogi/move",
    move: shogiMove,
    response: { engine_version: "yaneuraou-material-faeb37f0", nodes: 256, best_move: "7g7f" },
    result: "7g7f",
  },
];

afterEach(() => vi.restoreAllMocks());

function watchPublicFetch() {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected public fetch"));
}

test.each(moves)(
  "$path の着手をURL設定なしで認証付きBindingに送り応答を採用する",
  async ({ path, move, response, result }) => {
    const publicFetch = watchPublicFetch();
    const bindingFetch = vi.fn(async (request: Request) => {
      const { request_id, position_revision } = await request.json<Record<string, unknown>>();
      return Response.json({
        request_id,
        position_revision,
        ...response,
      });
    });

    expect(await move({ ...enabled, AI_GATEWAY: { fetch: bindingFetch } })).toEqual(result);
    const request = bindingFetch.mock.calls[0]![0];
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(new URL(request.url).pathname).toBe(path);
    expect(request.method).toBe("POST");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(publicFetch).not.toHaveBeenCalled();
  },
);

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%s のウォームアップをURL設定なしで認証付きBindingに送る",
  async (game) => {
    const publicFetch = watchPublicFetch();
    const bindingFetch = vi.fn(async (_request: Request) => Response.json({ status: "ok" }));

    expect(
      await requestRatedAiWarmup(
        { ...enabled, AI_GATEWAY: { fetch: bindingFetch } },
        game,
        Date.now() + 30_000,
      ),
    ).toBeNull();
    const request = bindingFetch.mock.calls[0]![0];
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe(
      `/admin/warmup?game=${game}`,
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(publicFetch).not.toHaveBeenCalled();
  },
);

test("Bindingが失敗した場合は同じBindingで再試行し、設定済みの公開URLへ送らない", async () => {
  const publicFetch = watchPublicFetch();
  const bindingFetch = vi.fn(async () => new Response(null, { status: 503 }));

  const result = await fourReversiMove(
    {
      ...enabled,
      AI_GATEWAY: { fetch: bindingFetch },
      AI_SERVICE_URL: "https://ai.example.test",
    },
    true,
  );

  expect(result).toEqual({ position: null, reason: "http_503" });
  expect(bindingFetch).toHaveBeenCalledTimes(2);
  expect(publicFetch).not.toHaveBeenCalled();
});

test("Bindingのない環境では明示したローカルHTTPサービスへ認証付きで送る", async () => {
  const httpFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { request_id, position_revision, nodes } = JSON.parse(String(init?.body));
    return Response.json({
      request_id,
      position_revision,
      nodes,
      engine_version: "yaneuraou-material-faeb37f0",
      best_move: "7g7f",
    });
  });

  expect(await shogiMove({ ...enabled, AI_SERVICE_URL: "http://127.0.0.1:3001" })).toBe("7g7f");
  expect(httpFetch).toHaveBeenCalledTimes(1);
  expect(String(httpFetch.mock.calls[0]![0])).toBe("http://127.0.0.1:3001/v1/shogi/move");
  expect(new Headers(httpFetch.mock.calls[0]![1]?.headers).get("Authorization")).toBe(
    `Bearer ${token}`,
  );
});

test("将棋は最初の2手にだけ定跡を指定し、指定が照合できない応答を採用しない", async () => {
  const sent: unknown[] = [];
  const bindings = {
    ...enabled,
    AI_GATEWAY: {
      fetch: async (request: Request) => {
        const input = await request.json<{
          opening_book?: string;
          request_id: string;
          position_revision: string;
          nodes: number;
        }>();
        sent.push(input.opening_book);
        return Response.json({
          request_id: input.request_id,
          position_revision: input.position_revision,
          engine_version: "yaneuraou-material-faeb37f0",
          nodes: input.nodes,
          best_move: "7g7f",
        });
      },
    },
  };

  expect(
    await requestShogiAiMove(bindings, { job: nextJob(), moves: [], standardBook: true }),
  ).toBeNull();
  expect(
    await requestShogiAiMove(bindings, {
      job: nextJob(),
      moves: ["7g7f", "3c3d"],
      standardBook: true,
    }),
  ).toBe("7g7f");
  expect(sent).toEqual(["standard-v1", undefined]);
});

test("Bindingだけでも接続先を認識し、トークンの検証後にAI接続を有効にする", () => {
  const binding = { AI_GATEWAY: { fetch: vi.fn() } };
  expect(aiServiceEnabled(binding)).toBe(true);
  expect(aiServiceConfigured(binding)).toBe(false);
  expect(aiServiceConfigured({ ...binding, AI_SERVICE_TOKEN: "too-short" })).toBe(false);
  expect(aiServiceConfigured({ ...binding, AI_SERVICE_TOKEN: token })).toBe(true);
});
