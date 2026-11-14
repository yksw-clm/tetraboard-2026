import { z } from "zod";
import { createHash } from "node:crypto";
import {
  isFourShogiRoom,
  getFourShogiAnalysisReplayContract,
  fourShogiActionSchema,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import profiles from "../../../packages/ai/configs/continuous-analysis-profiles-v1.json";
import { Api } from "./api";
import { actionKey, type Action, type Turn } from "./game";
import { sleep } from "./config";

const progressSchema = z.object({
  api_version: z.literal(2),
  request_id: z.uuid(),
  position_revision: z.string(),
  profile_hash: z.string(),
  profile_id: z.string(),
  sequence: z.int().nonnegative(),
  status: z.enum(["running", "stopped", "failed"]),
  game: z.enum(["four-reversi", "four-shogi"]),
  candidates: z
    .array(
      z.union([
        z.object({ action: fourShogiActionSchema, score: z.number().finite() }),
        z.object({ position: z.object({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }) }),
      ]),
    )
    .max(3),
});
export interface Analysis {
  watch(
    turn: Turn,
    api: Api,
    signal: AbortSignal,
    candidate: (action: Action) => void,
  ): Promise<void>;
  close(): Promise<void>;
}
export class LocalAi implements Analysis {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private endpoint = "";
  private token = "";
  private closed = false;
  private starting: Promise<void> | null = null;
  constructor(
    private binary = new URL(
      "../../../packages/ai/target/release/tetraboard-ai-local",
      import.meta.url,
    ).pathname,
  ) {}
  async start(): Promise<void> {
    if (this.closed) throw Error("AIは終了しています");
    if (this.endpoint && this.child?.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }
  private async launch(): Promise<void> {
    this.token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const child = Bun.spawn([this.binary, "--port", "0"], {
      env: { ...process.env, AI_LOCAL_TOKEN: this.token },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.child = child;
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        (async () => {
          while (!buffer.includes("\n")) {
            const next = await reader.read();
            if (next.done || buffer.length > 4096) throw Error("AIの起動応答が不正です");
            buffer += new TextDecoder().decode(next.value);
          }
          return z
            .object({
              listen: z.string().regex(/^127\.0\.0\.1:[1-9]\d{0,4}$/),
              service: z.literal("local-analysis"),
            })
            .parse(JSON.parse(buffer.split("\n", 1)[0]));
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(Error("AIを起動できません")), 5000);
        }),
      ]);
      if (this.closed || this.child !== child) throw Error("AIの起動を中止しました");
      this.endpoint = `http://${message.listen}`;
    } catch {
      child.kill("SIGKILL");
      await child.exited;
      this.endpoint = "";
      throw Error("ローカルAIを起動できません。build:aiを実行してください");
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async watch(
    turn: Turn,
    api: Api,
    signal: AbortSignal,
    candidate: (action: Action) => void,
  ): Promise<void> {
    await this.start();
    if (signal.aborted) return;
    const game = turn.room.settings.game;
    const profile = profiles.profiles.find((p) => p.game === game)!;
    const input = await analysisInput(turn, api, signal);
    if (signal.aborted) return;
    const request = {
      api_version: 2,
      request_id: crypto.randomUUID(),
      position_revision: createHash("sha256").update(turn.key).digest("hex"),
      profile_hash: profile.hash,
      input,
    };
    const endpoint = this.endpoint;
    const headers = { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
    const path = `${endpoint}/v2/analysis/${request.request_id}`;
    const call = async (url: string, method: string, body?: unknown) => {
      const response = await fetch(url, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw Error("AIの応答が不正です");
      const progress = progressSchema.parse(await response.json());
      if (
        progress.request_id !== request.request_id ||
        progress.position_revision !== request.position_revision ||
        progress.profile_hash !== profile.hash ||
        progress.profile_id !== profile.id ||
        progress.game !== game ||
        progress.status !== "running"
      )
        throw Error("AIの探索対象が一致しません");
      return progress;
    };
    try {
      let progress = await call(`${endpoint}/v2/analysis`, "POST", request);
      let sequence = -1;
      while (!signal.aborted) {
        if (progress.sequence > sequence) {
          sequence = progress.sequence;
          const first = progress.candidates[0];
          if (first) {
            const action: Action =
              "action" in first ? first.action : { type: "placeStone", position: first.position };
            if (!turn.actions.some((a) => actionKey(a) === actionKey(action)))
              throw Error("AIが不正な候補を返しました");
            candidate(action);
          }
        }
        await sleep(250);
        if (!signal.aborted) progress = await call(path, "GET");
      }
    } finally {
      // 取消完了を着手の送信条件にしないよう、探索側だけで待ちます。
      await fetch(path, {
        method: "DELETE",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.endpoint = "";
    if (!child || child.exitCode !== null) return;
    child.kill("SIGINT");
    await Promise.race([child.exited, sleep(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
export async function analysisInput(turn: Turn, api: Api, signal: AbortSignal): Promise<unknown> {
  const room = turn.room;
  if (!isFourShogiRoom(room)) {
    const g = room.game;
    return {
      game: "four-reversi",
      state: {
        board: g.board,
        turn: g.turn,
        moveNumber: g.moveNumber,
        lastMove: g.lastMove,
        eliminatedColors: g.eliminatedColors,
        consecutivePasses: g.consecutivePasses,
      },
    };
  }
  const events: FourShogiReplayEvent[] = [];
  let total: number | null = null;
  for (;;) {
    const query = new URLSearchParams({
      instanceId: room.instanceId,
      positionRevision: String(room.positionRevision),
      cursor: String(events.length),
    });
    const page = await api.request(
      `/api${getFourShogiAnalysisReplayContract.pathFor(room.id, room.roundId)}?${query}`,
      getFourShogiAnalysisReplayContract.response,
      { signal },
    );
    if (
      page.instanceId !== room.instanceId ||
      page.roundId !== room.roundId ||
      page.positionRevision !== room.positionRevision ||
      page.initial.threePlayerAttackProhibited !== room.game.threePlayerAttackProhibited ||
      (total !== null && total !== page.eventCount)
    )
      throw Error("棋譜の局面が一致しません");
    total = page.eventCount;
    const next = events.length + page.events.length;
    if (
      next > total ||
      (page.nextCursor === null
        ? next !== total
        : page.events.length === 0 || page.nextCursor !== next || next >= total)
    )
      throw Error("棋譜のページが連続していません");
    for (const event of page.events) {
      if (event.index !== events.length) throw Error("棋譜が不足しています");
      events.push(event.event);
    }
    if (page.nextCursor === null) break;
  }
  const g = room.game;
  const sides = ["south", "west", "north", "east"] as const;
  const kinds = ["rook", "gold", "silver", "pawn"] as const;
  return {
    game: "four-shogi",
    three_player_attack_prohibited: g.threePlayerAttackProhibited,
    events,
    state: {
      board: g.board.map((row) =>
        row.map((p) => (p ? { side: p.side, kind: p.kind, promoted: p.promoted } : null)),
      ),
      hands: sides.map((side) => kinds.map((kind) => g.hands[side][kind])),
      turn: g.turn,
      moveNumber: g.moveNumber,
      eliminatedSides: g.eliminations.map((e) => e.side),
    },
  };
}
