import { z } from "zod";
import {
  fourShogiPublicStateSchema,
  fourShogiActionSchema,
  fourShogiReplayEventSchema,
  type FourShogiPublicState,
} from "@tetraboard/protocol";
import continuousProfiles from "../../../packages/ai/configs/continuous-analysis-profiles-v1.json";
import { getLegalMoves, type FourReversiState } from "@tetraboard/four-reversi";
import { localProfile, localProfileIds } from "./profiles";
export const channel = "tetraboard-local-ai-v1";
export const colors = ["black", "white", "red", "blue"] as const;
export const colorNames = { black: "黒", white: "白", red: "赤", blue: "青" };
const color = z.enum(colors);
export const positionSchema = z.object({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) });
export const gameSchema = z.object({
  mode: z.literal("singles"),
  status: z.literal("playing"),
  board: z.array(z.array(color.nullable()).length(8)).length(8),
  turn: color,
  moveNumber: z.int().min(0).max(56),
  lastMove: positionSchema.nullable(),
  eliminatedColors: z.array(color).max(3),
  consecutivePasses: z.array(color).max(4),
  result: z.null(),
});
const observationBase = z.object({
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  generation: z.int().nonnegative(),
  connected: z.boolean(),
  selfId: z.uuid().nullable(),
  serverNowMs: z.number().nonnegative(),
  status: z.enum(["waiting", "playing"]),
  players: z.array(z.object({ id: z.uuid(), color: color.nullable() })).max(4),
  connectedPlayerIds: z.array(z.uuid()).max(4),
  turnStartedAt: z.number().nullable(),
});
export const reversiObservationSchema = observationBase.extend({
  gameId: z.literal("four-reversi"),
  game: gameSchema.nullable(),
});
export const shogiObservationSchema = observationBase.omit({ players: true }).extend({
  gameId: z.literal("four-shogi"),
  players: z
    .array(z.object({ id: z.uuid(), side: z.enum(["south", "west", "north", "east"]).nullable() }))
    .max(4),
  game: fourShogiPublicStateSchema.nullable(),
  roundId: z.uuid().nullable(),
  positionRevision: z.int().nonnegative(),
  legalActions: z.array(fourShogiActionSchema),
});
export const observationSchema = z.discriminatedUnion("gameId", [
  reversiObservationSchema,
  shogiObservationSchema,
]);
export type ReversiObservation = z.infer<typeof reversiObservationSchema>;
export type ShogiObservation = z.infer<typeof shogiObservationSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type ActiveObservation =
  | (ReversiObservation & { game: z.infer<typeof gameSchema> })
  | (ShogiObservation & { game: Extract<FourShogiPublicState, { status: "playing" }> });
export const analysisRequestSchema = z
  .object({
    api_version: z.literal(1),
    ruleset_version: z.literal("four-reversi-singles-v2"),
    state_version: z.literal(2),
    request_id: z.uuid(),
    position_revision: z.string().regex(/^[a-f0-9]{64}$/),
    profile_id: z.enum(localProfileIds),
    state: z.object({
      board: gameSchema.shape.board,
      turn: color,
      moveNumber: gameSchema.shape.moveNumber,
      lastMove: positionSchema.nullable(),
      eliminatedColors: z.array(color).max(3),
      consecutivePasses: z.array(color).max(4),
    }),
  })
  .strict();
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export const analysisResponseSchema = z.object({
  api_version: z.literal(1),
  request_id: z.uuid(),
  position_revision: z.string(),
  profile_id: z.enum(localProfileIds),
  profile_hash: z.string().regex(/^[a-f0-9]{64}$/),
  engine_version: z.string(),
  effective_limits: z.object({
    max_iterations: z.int().positive().max(8192),
    max_nodes: z.int().positive().max(262144),
    max_time_ms: z.literal(2000),
  }),
  reproducible: z.literal(false),
  cancelled: z.boolean(),
  candidates: z
    .array(
      z.object({
        position: positionSchema,
        visits: z.int().positive(),
        solo_wins: z.array(z.int().nonnegative()).length(4),
      }),
    )
    .max(3),
  diagnostics: z.object({
    nodes: z.int().nonnegative(),
    mcts: z.object({
      trials: z.int().nonnegative(),
      stop_reason: z.enum(["iteration_limit", "node_limit", "deadline", "terminal"]),
    }),
  }),
});
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
export function supportedUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return [
      "https://tetraboard.net",
      "https://tetraboard-dev.chaossi-lab.workers.dev",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ].includes(u.origin);
  } catch {
    return false;
  }
}
export function roomIdFromUrl(value: string): string | null {
  try {
    return new URL(value).pathname.match(/^\/rooms\/(\d{5})\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}
export function eligible(o: Observation | null): o is ActiveObservation {
  if (
    !o ||
    !o.connected ||
    o.status !== "playing" ||
    !o.game ||
    o.game.status !== "playing" ||
    o.game.mode !== "singles" ||
    !o.selfId ||
    !o.connectedPlayerIds.includes(o.selfId)
  )
    return false;
  if (o.gameId === "four-reversi") {
    const color = o.players.find((p) => p.id === o.selfId)?.color;
    return !!color && !o.game.eliminatedColors.includes(color);
  }
  const side = o.players.find((p) => p.id === o.selfId)?.side;
  return !!side && !o.game.eliminations.some((e) => e.side === side);
}
export function selfColor(o: Observation) {
  return o.gameId === "four-reversi"
    ? (o.players.find((p) => p.id === o.selfId)?.color ?? null)
    : (o.players.find((p) => p.id === o.selfId)?.side ?? null);
}
export function positionIdentity(o: Observation, origin: string, epoch: number): string {
  return JSON.stringify([
    origin,
    o.gameId,
    o.roomId,
    o.instanceId,
    o.generation,
    epoch,
    o.selfId,
    o.players,
    o.status,
    o.game,
    o.turnStartedAt,
    o.gameId === "four-shogi" ? [o.roundId, o.positionRevision] : null,
  ]);
}
export async function revision(identity: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function validateResult(value: unknown, request: AnalysisRequest): AnalysisResponse {
  const result = analysisResponseSchema.parse(value);
  const expected = localProfile(request.profile_id);
  if (
    result.request_id !== request.request_id ||
    result.position_revision !== request.position_revision ||
    result.cancelled ||
    result.profile_id !== request.profile_id ||
    result.profile_hash !== expected.hash ||
    result.effective_limits.max_iterations !== expected.limits.max_iterations ||
    result.effective_limits.max_nodes !== expected.limits.max_nodes ||
    result.effective_limits.max_time_ms !== expected.limits.max_time_ms ||
    result.diagnostics.nodes > result.effective_limits.max_nodes ||
    result.diagnostics.mcts.trials > result.effective_limits.max_iterations
  )
    throw Error("解析対象が一致しません");
  const legal = getLegalMoves({
    ...request.state,
    mode: "singles",
    status: "playing",
    result: null,
  } as FourReversiState);
  const seen = new Set<string>();
  for (const c of result.candidates) {
    const key = `${c.position.x},${c.position.y}`;
    if (
      seen.has(key) ||
      !legal.some((p) => p.x === c.position.x && p.y === c.position.y) ||
      c.solo_wins.some((n) => n > c.visits) ||
      c.solo_wins.reduce((a, b) => a + b, 0) > c.visits
    )
      throw Error("解析候補が不正です");
    seen.add(key);
  }
  return result;
}

export const sideNames = { south: "南", west: "西", north: "北", east: "東" };
export const sides = ["south", "west", "north", "east"] as const;
export const handKinds = ["rook", "gold", "silver", "pawn"] as const;
export const pieceNames = { king: "王", rook: "飛", gold: "金", silver: "銀", pawn: "歩" };
export function continuousProfile(game: Observation["gameId"]) {
  return continuousProfiles.profiles.find((p) => p.game === game)!;
}
const shogiPositionSchema = z.strictObject({
  board: z
    .array(
      z
        .array(
          z
            .strictObject({
              side: z.enum(sides),
              kind: z.enum(["king", ...handKinds]),
              promoted: z.boolean(),
            })
            .nullable(),
        )
        .length(9),
    )
    .length(9),
  hands: z.array(z.array(z.int().min(0).max(36)).length(4)).length(4),
  turn: z.enum(sides),
  moveNumber: z.int().nonnegative(),
  eliminatedSides: z.array(z.enum(sides)).max(3),
});
export const continuousRequestSchema = z.strictObject({
  api_version: z.literal(2),
  request_id: z.uuid(),
  position_revision: z.string().regex(/^[a-f0-9]{64}$/),
  profile_hash: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.discriminatedUnion("game", [
    z.strictObject({ game: z.literal("four-reversi"), state: analysisRequestSchema.shape.state }),
    z.strictObject({
      game: z.literal("four-shogi"),
      three_player_attack_prohibited: z.boolean(),
      events: z.array(fourShogiReplayEventSchema),
      state: shogiPositionSchema,
    }),
  ]),
});
export type ContinuousRequest = z.infer<typeof continuousRequestSchema>;
const responseBase = z.object({
  api_version: z.literal(2),
  request_id: z.uuid(),
  position_revision: z.string(),
  profile_id: z.string(),
  profile_hash: z.string(),
  status: z.enum(["running", "stopped", "failed"]),
  sequence: z.int().nonnegative(),
  reproducible: z.literal(false),
  error: z.string().optional(),
});
export const continuousResponseSchema = z.discriminatedUnion("game", [
  responseBase.extend({
    game: z.literal("four-reversi"),
    candidates: analysisResponseSchema.shape.candidates,
    diagnostics: z.object({
      trials: z.int().nonnegative().optional(),
      nodes: z.int().nonnegative().optional(),
      tree_nodes: z.int().min(1).max(65536).optional(),
    }),
  }),
  responseBase.extend({
    game: z.literal("four-shogi"),
    candidates: z
      .array(z.object({ action: fourShogiActionSchema, score: z.number().finite() }))
      .max(3),
    diagnostics: z.object({
      completed_depth: z.int().nonnegative().optional(),
      nodes: z.int().nonnegative().optional(),
      work: z.int().nonnegative().optional(),
    }),
  }),
]);
export type ContinuousResponse = z.infer<typeof continuousResponseSchema>;
export function validateProgress(
  value: unknown,
  request: ContinuousRequest,
  observation: ActiveObservation,
): ContinuousResponse {
  const result = continuousResponseSchema.parse(value),
    profile = continuousProfile(request.input.game);
  if (
    result.game !== request.input.game ||
    result.request_id !== request.request_id ||
    result.position_revision !== request.position_revision ||
    result.profile_id !== profile.id ||
    result.profile_hash !== request.profile_hash ||
    result.profile_hash !== profile.hash
  )
    throw Error("解析対象が一致しません");
  const seen = new Set<string>();
  if (result.game === "four-reversi" && observation.gameId === "four-reversi") {
    const legal = getLegalMoves(observation.game);
    for (const c of result.candidates) {
      const key = JSON.stringify(c.position);
      if (
        seen.has(key) ||
        !legal.some((p) => p.x === c.position.x && p.y === c.position.y) ||
        c.visits > (result.diagnostics.trials ?? 0) ||
        c.solo_wins.some((n) => n > c.visits) ||
        c.solo_wins.reduce((a, b) => a + b, 0) > c.visits
      )
        throw Error("解析候補が不正です");
      seen.add(key);
    }
  } else if (result.game === "four-shogi" && observation.gameId === "four-shogi") {
    for (const c of result.candidates) {
      const key = actionKey(c.action);
      if (seen.has(key) || !observation.legalActions.some((a) => actionKey(a) === key))
        throw Error("解析候補が不正です");
      seen.add(key);
    }
  } else throw Error("解析対象が一致しません");
  return result;
}
export function actionKey(action: z.infer<typeof fourShogiActionSchema>): string {
  return action.type === "movePiece"
    ? `move:${action.from.x},${action.from.y}:${action.to.x},${action.to.y}:${action.promote}`
    : `drop:${action.pieceKind}:${action.to.x},${action.to.y}`;
}
