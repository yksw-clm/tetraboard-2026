import { createHash } from "node:crypto";
import { z } from "zod";
import * as reversi from "@tetraboard/four-reversi";
import * as shogi from "@tetraboard/four-shogi";
import {
  fourReversiStateSchema,
  fourShogiReplayEventSchema,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import {
  readFourReversiMatchRecord,
  readFourShogiMatchRecord,
} from "../src/accounts/matchDataContracts";
import type { MatchRecord } from "../src/rooms/matchStore";
import type { ShogiMatchRecord } from "../src/rooms/shogiMatchStore";

const colorSchema = z.enum([...reversi.colors, ...shogi.sides]);
const sourceSchema = z.object({
  match: z.object({
    id: z.uuid(),
    gameType: z.enum(["four-reversi", "four-shogi"]),
    version: z.literal(1),
    roomId: z.string().regex(/^\d{5}$/),
    startedAt: z.int().nonnegative(),
    endedAt: z.int().nonnegative(),
    moveCount: z.int().nonnegative(),
    movesChunkCount: z.int().nonnegative(),
    gamePlayers: z.array(z.object({ seat: z.int().min(0).max(3), color: colorSchema })).length(4),
    playerSnapshots: z
      .array(z.object({ uid: z.string().min(1), name: z.string(), seat: z.int().min(0).max(3) }))
      .length(4),
    players: z
      .array(
        z.object({
          uid: z.string().min(1),
          seat: z.int().min(0).max(3),
          rank: z.int().min(1).max(4).nullable(),
          result: z.enum(["win", "lose", "draw"]),
          isWinner: z.boolean(),
        }),
      )
      .length(4),
    meta: z
      .object({
        fourShogiMode: z.enum(["singles", "doubles"]).optional(),
        forbidThreePlayerAttack: z.boolean(),
      })
      .optional(),
  }),
  moves: z.array(z.unknown()),
  moveChunks: z.array(z.object({ index: z.int().nonnegative(), moves: z.array(z.unknown()) })),
});
type Source = z.infer<typeof sourceSchema>;
const linkSchema = z.object({
  sourceUid: z.string().min(1),
  sourceName: z.string().min(1),
  accountId: z.string().min(1),
  username: z.string().min(1),
});
export type FirebaseAccountLink = z.infer<typeof linkSchema>;
const targetSchema = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      profileCompleted: z.number(),
      isAnonymous: z.number().nullable(),
    }),
  ),
  matches: z.array(
    z.object({
      id: z.string(),
      game: z.string(),
      mode: z.string(),
      started_at_ms: z.number(),
      ended_at_ms: z.number(),
      record_json: z.string(),
    }),
  ),
  chunks: z.array(
    z.object({
      match_id: z.string(),
      chunk_index: z.number(),
      start_index: z.number(),
      event_count: z.number(),
      events_json: z.string(),
    }),
  ),
  history: z.array(
    z.object({
      account_id: z.string(),
      match_id: z.string(),
      game: z.string(),
      mode: z.string(),
      started_at_ms: z.number(),
    }),
  ),
});
export type FirebaseMatchTarget = z.infer<typeof targetSchema>;
export type PreparedFirebaseMatch =
  | { game: "four-reversi"; record: MatchRecord; events: [] }
  | { game: "four-shogi"; record: ShogiMatchRecord; events: FourShogiReplayEvent[] };

// 移行を再実行しても同じ席・局世代を参照できるUUID v8を生成します。
function stableId(key: string): string {
  const chars = createHash("sha256")
    .update(`firebase:tetra-board:${key}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "8";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Firebase版 f70c9ba の初期配置を維持し、現行の盤面へ置き換えません。
export function firebaseReversiInitial(): reversi.FourReversiState {
  const state = reversi.createInitialState("singles");
  const board: reversi.Cell[][] = Array.from({ length: 8 }, () =>
    Array<reversi.Cell>(8).fill(null),
  );
  for (const [color, x, y] of [
    ["black", 3, 3],
    ["black", 2, 4],
    ["white", 5, 3],
    ["white", 4, 4],
    ["red", 3, 2],
    ["red", 4, 3],
    ["blue", 3, 4],
    ["blue", 4, 5],
  ] as const)
    board[y][x] = color;
  return { ...state, board };
}

function checkSource(source: Source): void {
  const m = source.match;
  if (
    m.endedAt < m.startedAt ||
    source.moves.length !== m.moveCount ||
    source.moveChunks.length !== m.movesChunkCount
  )
    throw new Error(`Invalid source counts or dates: ${m.id}`);
  const chunks = [...source.moveChunks].sort((a, b) => a.index - b.index);
  if (
    chunks.some((c, i) => c.index !== i) ||
    stableJson(chunks.flatMap((c) => c.moves)) !== stableJson(source.moves)
  )
    throw new Error(`Invalid source chunks: ${m.id}`);
  for (const players of [m.gamePlayers, m.playerSnapshots, m.players])
    if (new Set(players.map((p) => p.seat)).size !== 4)
      throw new Error(`Invalid source seats: ${m.id}`);
  if (
    new Set(m.gamePlayers.map((p) => p.color)).size !== 4 ||
    new Set(m.playerSnapshots.map((p) => p.uid)).size !== 4 ||
    m.players.some((p) => !m.playerSnapshots.some((s) => s.uid === p.uid && s.seat === p.seat))
  )
    throw new Error(`Invalid source identities: ${m.id}`);
}

function agreesWithSource(source: Source, prepared: PreparedFirebaseMatch): boolean {
  const result = prepared.record.game.result;
  return source.match.players.every((p) => {
    const color = source.match.gamePlayers.find((x) => x.seat === p.seat)!.color;
    if (result.mode === "singles") {
      const rank = result.standings.find((x) => ("side" in x ? x.side : x.color) === color)?.rank;
      return (
        rank === p.rank && (rank === 1 ? "win" : "lose") === p.result && p.isWinner === (rank === 1)
      );
    }
    const outcome =
      result.winner === null ? "draw" : result.winner.split("-").includes(color) ? "win" : "lose";
    return p.rank === null && p.result === outcome && p.isWinner === (outcome === "win");
  });
}

function convert(source: Source, links: FirebaseAccountLink[]): PreparedFirebaseMatch | string {
  const m = source.match;
  if (m.gameType === "four-shogi" && !m.meta?.fourShogiMode) return "missing_mode";
  const identities = [...m.playerSnapshots]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: stableId(`${m.id}:player:${p.uid}`),
      name: p.name,
      seat: p.seat,
      kind: "human" as const,
      accountId: links.find((l) => l.sourceUid === p.uid)?.accountId ?? null,
    }));
  const base = {
    id: m.id,
    roomId: m.roomId,
    instanceId: stableId(`${m.id}:instance`),
    startedAtMs: m.startedAt,
    endedAtMs: m.endedAt,
  };
  let prepared: PreparedFirebaseMatch;
  if (m.gameType === "four-reversi") {
    const participants = identities.map((p) => ({
      ...p,
      color: z.enum(reversi.colors).parse(m.gamePlayers.find((x) => x.seat === p.seat)!.color),
    }));
    const initial = firebaseReversiInitial();
    let state = initial;
    const steps: MatchRecord["replay"]["steps"] = [];
    for (const raw of source.moves) {
      const move = z
        .object({
          color: z.enum(reversi.colors),
          x: z.int().min(0).max(7),
          y: z.int().min(0).max(7),
        })
        .parse(raw);
      if (state.status !== "playing" || state.turn !== move.color) return "turn_mismatch";
      const position = { x: move.x, y: move.y };
      const next = reversi.applyAction(state, { type: "placeStone", position });
      if (!next.ok) return next.reason;
      state = next.state;
      steps.push({
        action: { type: "place", color: move.color, position },
        game: fourReversiStateSchema.parse(state),
        passedColors: [...next.passedColors],
      });
    }
    if (state.status !== "finished") return "unfinished";
    const record = readFourReversiMatchRecord(
      JSON.stringify({
        ...base,
        settings: { game: m.gameType, mode: "singles", timeControl: null },
        participants,
        game: state,
        eliminations: [],
        replay: { id: m.id, initial, steps },
      }),
    );
    prepared = { game: m.gameType, record, events: [] };
  } else {
    const participants = identities.map((p) => ({
      ...p,
      side: z.enum(shogi.sides).parse(m.gamePlayers.find((x) => x.seat === p.seat)!.color),
    }));
    const players = Object.fromEntries(participants.map((p) => [p.side, p.id])) as Record<
      shogi.Side,
      string
    >;
    const initial = {
      mode: m.meta!.fourShogiMode!,
      players,
      threePlayerAttackProhibited: m.meta!.forbidThreePlayerAttack,
    };
    let state = shogi.createInitialState(initial);
    const knockouts = { south: 0, west: 0, north: 0, east: 0 };
    const events: FourShogiReplayEvent[] = [];
    for (const raw of source.moves) {
      const move = z
        .discriminatedUnion("type", [
          z.object({
            type: z.literal("move"),
            color: z.enum(shogi.sides),
            from: z.object({ x: z.int(), y: z.int() }),
            to: z.object({ x: z.int(), y: z.int() }),
            promote: z.boolean(),
          }),
          z.object({
            type: z.literal("drop"),
            color: z.enum(shogi.sides),
            to: z.object({ x: z.int(), y: z.int() }),
            kind: z.enum(shogi.handPieceKinds),
          }),
        ])
        .parse(raw);
      const event = fourShogiReplayEventSchema.parse({
        type: "action",
        side: move.color,
        action:
          move.type === "move"
            ? { type: "movePiece", from: move.from, to: move.to, promote: move.promote }
            : { type: "dropPiece", pieceKind: move.kind, to: move.to },
      });
      if (event.type !== "action") throw new Error("Invalid converted action");
      const next = shogi.applyAction(state, event.side, event.action);
      if (!next.ok) return next.reason;
      // Firebase版 f70c9ba は脱落者の持ち駒を残し、ダブルス終局で王を
      // 死王にしません。現行版のフレームが変わる局は移行しません。
      if (
        next.eliminations.length > 0 &&
        (initial.mode === "doubles" ||
          next.eliminations.some((e) =>
            shogi.handPieceKinds.some((kind) => state.hands[e.side][kind] > 0),
          ))
      )
        return "legacy_state_mismatch";
      if (initial.mode === "singles")
        knockouts[event.side] += next.eliminations.filter((e) => e.reason === "checkmate").length;
      state = next.state;
      events.push(event);
    }
    if (state.status !== "finished") return "unfinished";
    const { repetitions: _repetitions, ...game } = state;
    const record = readFourShogiMatchRecord(
      JSON.stringify({
        ...base,
        settings: {
          game: m.gameType,
          mode: initial.mode,
          timeControl: null,
          threePlayerAttackProhibited: initial.threePlayerAttackProhibited,
        },
        participants,
        game,
        knockouts,
        replay: { rulesVersion: 1, initial, eventCount: events.length },
      }),
    );
    prepared = { game: m.gameType, record, events };
  }
  return agreesWithSource(source, prepared) ? prepared : "result_mismatch";
}

function chunkRows(match: PreparedFirebaseMatch) {
  const rows: FirebaseMatchTarget["chunks"] = [];
  for (let start = 0; start < match.events.length; start += 100) {
    const events = match.events.slice(start, start + 100);
    rows.push({
      match_id: match.record.id,
      chunk_index: start / 100,
      start_index: start,
      event_count: events.length,
      events_json: JSON.stringify(events),
    });
  }
  return rows;
}

// 既存行は完全一致だけを許し、計画後に競合してもNOT NULL制約で停止します。
function guardedInsert(
  table: string,
  row: Record<string, string | number>,
  keyColumns: string[],
  extraGuard = "false",
): string {
  const literal = (v: string | number) => (typeof v === "number" ? String(v) : quote(v));
  const entries = Object.entries(row);
  const key = keyColumns.map((k) => `${k}=${literal(row[k])}`).join(" AND ");
  const mismatch = entries.map(([k, v]) => `${k} IS NOT ${literal(v)}`).join(" OR ");
  const values = entries.map(([, v], i) =>
    i === 0
      ? `CASE WHEN (${extraGuard}) OR EXISTS(SELECT 1 FROM ${table} WHERE ${key} AND (${mismatch})) THEN NULL ELSE ${literal(v)} END`
      : literal(v),
  );
  return `INSERT INTO ${table} (${entries.map(([k]) => k).join(", ")}) SELECT ${values.join(", ")} WHERE true ON CONFLICT(${keyColumns.join(", ")}) DO NOTHING;`;
}

export function prepareFirebaseMatches(
  sourceValue: unknown,
  linkValue: unknown,
  targetValue: unknown,
) {
  const sources = z.array(sourceSchema).parse(sourceValue);
  const links = z.array(linkSchema).parse(linkValue);
  const target = targetSchema.parse(targetValue);
  if (
    new Set(sources.map((s) => s.match.id)).size !== sources.length ||
    new Set(links.map((l) => l.sourceUid)).size !== links.length ||
    new Set(links.map((l) => l.accountId)).size !== links.length
  )
    throw new Error("Duplicate source or account mapping");
  for (const link of links) {
    const users = target.users.filter(
      (u) =>
        u.id === link.accountId &&
        u.username === link.username &&
        u.profileCompleted === 1 &&
        !u.isAnonymous,
    );
    const snapshots = sources
      .flatMap((s) => s.match.playerSnapshots)
      .filter((p) => p.uid === link.sourceUid);
    if (
      users.length !== 1 ||
      snapshots.length === 0 ||
      snapshots.some((p) => p.name !== link.sourceName)
    )
      throw new Error("Account mapping does not match source and target");
  }
  const matches: PreparedFirebaseMatch[] = [];
  const skipped: { id: string; game: string; reason: string }[] = [];
  for (const source of sources) {
    checkSource(source);
    const match = convert(source, links);
    if (typeof match === "string")
      skipped.push({ id: source.match.id, game: source.match.gameType, reason: match });
    else matches.push(match);
  }
  const sql: string[] = [];
  for (const match of matches) {
    const r = match.record;
    const row = {
      id: r.id,
      game: match.game,
      mode: r.settings.mode,
      started_at_ms: r.startedAtMs,
      ended_at_ms: r.endedAtMs,
      record_json: JSON.stringify(r),
    };
    const existing = target.matches.filter((m) => m.id === r.id);
    if (existing.some((m) => stableJson(m) !== stableJson(row)))
      throw new Error(`Conflicting target match: ${r.id}`);
    const chunks = chunkRows(match);
    const stored = target.chunks.filter((c) => c.match_id === r.id);
    if (stored.some((c) => !chunks.some((expected) => stableJson(c) === stableJson(expected))))
      throw new Error(`Conflicting target chunk: ${r.id}`);
    if (
      existing.length &&
      stableJson(stored.sort((a, b) => a.chunk_index - b.chunk_index)) !== stableJson(chunks)
    )
      throw new Error(`Incomplete target chunks: ${r.id}`);
    const history = r.participants
      .filter((p) => p.kind === "human" && p.accountId !== null)
      .map((p) => ({
        account_id: p.kind === "human" ? p.accountId! : "",
        match_id: r.id,
        game: match.game,
        mode: r.settings.mode,
        started_at_ms: r.startedAtMs,
      }));
    if (
      target.history
        .filter((h) => h.match_id === r.id)
        .some((h) => !history.some((expected) => stableJson(h) === stableJson(expected)))
    )
      throw new Error(`Conflicting target history: ${r.id}`);
    for (const chunk of chunks)
      sql.push(guardedInsert("shogi_match_chunks", chunk, ["match_id", "chunk_index"]));
    // 本体は全チャンクの後、本人索引は保存した本体と同じIDに対して生成します。
    const accountGuard =
      history
        .map((h) => {
          const link = links.find((l) => l.accountId === h.account_id)!;
          return `NOT EXISTS(SELECT 1 FROM user WHERE id=${quote(link.accountId)} AND username=${quote(link.username)} AND profileCompleted=1 AND (isAnonymous IS NULL OR isAnonymous=0))`;
        })
        .join(" OR ") || "false";
    sql.push(guardedInsert("matches", row, ["id"], accountGuard));
    for (const h of history)
      sql.push(guardedInsert("account_match_history", h, ["account_id", "match_id"], accountGuard));
  }
  return { matches, skipped, sql: sql.join("\n") + "\n" };
}
