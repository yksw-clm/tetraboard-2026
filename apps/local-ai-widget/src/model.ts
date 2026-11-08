import { z } from "zod";
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
export const observationSchema = z.object({
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  generation: z.int().nonnegative(),
  connected: z.boolean(),
  selfId: z.uuid().nullable(),
  serverNowMs: z.number().nonnegative(),
  status: z.enum(["waiting", "playing"]),
  players: z.array(z.object({ id: z.uuid(), color: color.nullable() })).max(4),
  connectedPlayerIds: z.array(z.uuid()).max(4),
  game: gameSchema.nullable(),
  turnStartedAt: z.number().nullable(),
});
export type Observation = z.infer<typeof observationSchema>;
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
export function eligible(
  o: Observation | null,
): o is Observation & { game: z.infer<typeof gameSchema> } {
  return (
    !!o &&
    o.connected &&
    o.status === "playing" &&
    !!o.game &&
    !!o.selfId &&
    o.connectedPlayerIds.includes(o.selfId) &&
    o.players.some((p) => p.id === o.selfId && p.color !== null)
  );
}
export function selfColor(o: Observation) {
  return o.players.find((p) => p.id === o.selfId)?.color ?? null;
}
export function positionIdentity(o: Observation, origin: string, epoch: number): string {
  return JSON.stringify([
    origin,
    o.roomId,
    o.instanceId,
    o.generation,
    epoch,
    o.selfId,
    o.players,
    o.status,
    o.game,
    o.turnStartedAt,
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
