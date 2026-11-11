import { isDeepStrictEqual } from "node:util";
import * as fourReversi from "../../four-reversi/src/index";
import * as fourShogi from "../../four-shogi/src/index";
import * as reversi from "../../reversi/src/index";
import * as shogi from "../../shogi/src/index";
import profiles from "../configs/profiles-v1.json";

export type AiGame = "four-reversi" | "four-shogi" | "shogi" | "reversi";
export const aiGames: AiGame[] = ["four-reversi", "four-shogi", "shogi", "reversi"];
type Body = Record<string, unknown>;
export type Probe = { game: AiGame; path: string; body: Body; valid: (body: Body) => boolean };
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function deploymentProbes(): Probe[] {
  const four = fourReversi.createInitialState("singles");
  const ordinary = reversi.createInitialState();
  const fourShogiState = fourShogi.createInitialState({
    mode: "singles",
    players: { south: "S", west: "W", north: "N", east: "E" },
    threePlayerAttackProhibited: true,
  });
  const shogiState = shogi.createInitialState({ players: { south: "S", north: "N" } });
  const legalUsi = shogi.getLegalActions(shogiState).flatMap((action) => {
    if (action.type !== "movePiece") return [];
    const square = ({ x, y }: { x: number; y: number }) => `${9 - x}${"abcdefghi"[y]}`;
    return [`${square(action.from)}${square(action.to)}${action.promote ? "+" : ""}`];
  });
  return [
    ...profiles.profiles
      .filter((p) => p.id !== "lv4-v1")
      .map((profile): Probe => ({
        game: "four-reversi",
        path: "/v2/move",
        body: {
          api_version: 2,
          game_id: "four-reversi",
          ruleset_version: "four-reversi-singles-v2",
          state_version: 2,
          profile_id: profile.id,
          seed: 7,
          state: {
            board: four.board,
            turn: four.turn,
            moveNumber: 0,
            lastMove: null,
            consecutivePasses: [],
            eliminatedColors: [],
          },
        },
        valid: (body) =>
          body.api_version === 2 &&
          body.game_id === "four-reversi" &&
          body.agent_id === profile.config.agent_id &&
          body.ruleset_version === "four-reversi-singles-v2" &&
          body.state_version === 2 &&
          body.engine_version === "0.2.0" &&
          body.profile_id === profile.id &&
          body.profile_hash === profile.profile_hash &&
          fourReversi.getLegalMoves(four).some((p) => isDeepStrictEqual(p, body.position)),
      })),
    ...[4096, 16384, 65536].map((work): Probe => ({
      game: "four-shogi",
      path: "/v1/four-shogi/move",
      body: {
        api_version: 1,
        rules_version: 1,
        profile_id: `four-shogi-lv3-work${work}-v1`,
        three_player_attack_prohibited: true,
        turn: "south",
        events: [],
      },
      valid: (body) =>
        body.api_version === 1 &&
        body.rules_version === 1 &&
        body.engine_version === "four-shogi-lv3-v1" &&
        body.profile_id === `four-shogi-lv3-work${work}-v1` &&
        body.max_work === work &&
        body.max_time_ms === 500 &&
        fourShogi.getLegalActions(fourShogiState).some((a) => isDeepStrictEqual(a, body.action)),
    })),
    ...[64, 128, 256, 512, 1024].map((nodes): Probe => ({
      game: "shogi",
      path: "/v1/shogi/move",
      body: { moves: [], nodes, opening_book: "standard-v1" },
      valid: (body) =>
        body.engine_version === "yaneuraou-material-faeb37f0" &&
        body.nodes === nodes &&
        body.opening_book === "standard-v1" &&
        typeof body.best_move === "string" &&
        legalUsi.includes(body.best_move),
    })),
    ...[1, 2, 4, 8].map((level): Probe => ({
      game: "reversi",
      path: "/v1/reversi/move",
      body: {
        board: ordinary.board
          .flat()
          .map((c) => (c === null ? "-" : c === "black" ? "B" : "W"))
          .join(""),
        black_to_move: true,
        level,
      },
      valid: (body) =>
        body.engine_version === "egaroucid-console-7.8.2-0c1b84ef" &&
        body.level === level &&
        reversi.getLegalMoves(ordinary).some((p) => isDeepStrictEqual(p, body.position)),
    })),
  ];
}

export async function checkProbe(
  origin: string,
  token: string,
  probe: Probe,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const revision = "a".repeat(64);
  const started = performance.now();
  const response = await fetcher(new URL(probe.path, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...probe.body, request_id: requestId, position_revision: revision }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  ensure(response.ok, `${probe.game}: AI応答失敗 (${response.status})`);
  const body: unknown = await response.json();
  ensure(
    body !== null && typeof body === "object" && !Array.isArray(body),
    `${probe.game}: 不正な応答`,
  );
  const data = body as Body;
  ensure(
    data.request_id === requestId && data.position_revision === revision,
    `${probe.game}: 要求の不一致`,
  );
  ensure(probe.valid(data), `${probe.game}: エンジン版・profile・合法手の不一致`);
  console.log(`${probe.game}: 合法手・版確認成功 (${Math.round(performance.now() - started)}ms)`);
}

export async function checkAiDeployment(
  origins: Record<AiGame, string>,
  token: string,
  verifyConcurrency = false,
) {
  ensure(/^[\x21-\x7e]{32,256}$/.test(token), "AI_SERVICE_TOKENの設定が必要です");
  const probes = deploymentProbes();
  await completeChecks(
    aiGames.map(async (game) => {
      const selected = probes.filter((p) => p.game === game);
      if (game === "shogi" || game === "reversi")
        await checkEngineWarmup(origins[game], token, game);
      // 初回はコンテナ起動を含めて確認し、その後は実際の着手期限で全採用設定を照合します。
      await checkProbe(origins[game], token, selected[0]!, 60_000);
      for (const probe of selected)
        await checkProbe(origins[game], token, probe, game === "four-reversi" ? 10_000 : 5000);
      // 並列上限の負荷確認は一時コンテナだけで行い、本番の対局と4枠を取り合いません。
      if (verifyConcurrency)
        await completeChecks(
          Array.from({ length: 4 }, () =>
            checkProbe(
              origins[game],
              token,
              selected.at(-1)!,
              // amd64エミュレーションでも4要求を回収します。クラウドの期限内成功率は別途受入確認します。
              60_000,
            ),
          ),
        );
    }),
  );
}

export async function checkEngineWarmup(
  origin: string,
  token: string,
  game: "shogi" | "reversi",
  fetcher: typeof fetch = fetch,
) {
  const endpoint = new URL("/admin/warmup", origin);
  endpoint.searchParams.set("game", game);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  ensure(response.ok, `${game}: AI準備失敗 (${response.status})`);
  const body: unknown = await response.json();
  ensure(
    body !== null && typeof body === "object" && "status" in body && body.status === "ok",
    `${game}: AI準備の不正な応答`,
  );
  console.log(`${game}: エンジン初期化・着手生成確認成功`);
}

async function completeChecks(checks: Promise<void>[]) {
  // 一つの失敗後も開始済みの要求を回収してから、公開停止やコンテナの片付けへ進みます。
  const results = await Promise.allSettled(checks);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
