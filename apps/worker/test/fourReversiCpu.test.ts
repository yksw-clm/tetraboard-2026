import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  fourReversiRoomSchema,
  fourReversiStateSchema,
  roundReplaySchema,
} from "@tetraboard/protocol";
import {
  applyAction,
  chooseCpuMove,
  eliminateColor,
  type GameMode,
} from "@tetraboard/four-reversi";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import {
  FourReversiProgress,
  fourReversiCpuJobKey,
  type FourReversiCpuJob,
} from "../src/rooms/fourReversiProgress";
import { matchStartKey } from "../src/rooms/matchStore";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});
// 保存内容の検証は軽い選択で行い、Lv2の選択・期限・全読みは専用ケースで確認します。
async function setup(mode: GameMode = "singles", level = 1) {
  const entry = await fixtures.create({
    game: "four-reversi",
    name: "ホスト",
    quickPlay: true,
    cpuLevel: level,
    mode,
  });
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const at = Date.now() + 60_000;
  const before = await runInDurableObject(stub, async (_, ctx) => {
    const saved = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (saved.status !== "playing") throw Error("Expected playing");
    const cpu = saved.players.find((p) => p.kind === "cpu")!;
    const room = {
      ...saved,
      game: { ...saved.game, turn: cpu.color },
      clock: { ...saved.clock, turnStartedAt: at, turnExpiresAt: at + 300_000 },
    };
    ctx.storage.kv.put("room", room);
    ctx.storage.kv.delete(fourReversiCpuJobKey);
    await ctx.storage.setAlarm(at + 60_000);
    return room;
  });
  return { entry, host, stub, at, before };
}

for (const mode of ["singles", "doubles"] as const)
  for (const level of [1, 2]) {
    test(`${mode} Lv${level}: GETでは選択も適用もせず、2秒後の保存と休止復帰後の着手を分離する`, async () => {
      const { stub, at, before } = await setup(mode, level);
      const job = await runInDurableObject(stub, async (instance, ctx) => {
        const replay = ctx.storage.kv.get("round-replay");
        const clock = vi.spyOn(Date, "now").mockReturnValue(at + 1999);
        try {
          await instance.alarm();
          expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
          clock.mockReturnValue(at + 2000);
          expect(await instance.getRoom()).toEqual(before);
          expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
          await instance.alarm();
          const selected = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
          expect(selected).toMatchObject({
            instanceId: before.instanceId,
            color: before.game.turn,
            level,
            turnStartedAt: at,
            applyAt: at + 2001,
          });
          expect(ctx.storage.kv.get("room")).toEqual(before);
          expect(ctx.storage.kv.get("round-replay")).toEqual(replay);
          expect(await ctx.storage.getAlarm()).toBe(at + 2001);
          if (level === 2) expect(selected.move).toEqual(chooseCpuMove(before.game, 2));
          return selected;
        } finally {
          clock.mockRestore();
        }
      });
      await evictDurableObject(stub, { webSockets: "hibernate" });
      await runInDurableObject(stub, async (instance, ctx) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2001);
        try {
          expect((await instance.getRoom())?.game).toEqual(before.game);
          await instance.alarm();
          const moved = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
          const expected = applyAction(before.game, { type: "placeStone", position: job.move });
          expect(expected.ok && moved.game).toEqual(expected.ok && expected.state);
          expect(moved.clock?.turnStartedAt).toBe(at + 2001);
          expect(roundReplaySchema.parse(ctx.storage.kv.get("round-replay")).steps).toHaveLength(1);
          expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
          await instance.alarm();
          expect(ctx.storage.kv.get("room")).toEqual(moved);
        } finally {
          clock.mockRestore();
        }
      });
    });
  }

test.each([
  "部屋世代",
  "別局",
  "本人",
  "色",
  "レベル",
  "時計",
  "盤面",
  "手番外脱落",
  "不正手",
  "不正時刻",
  "壊れたジョブ",
])("古い・不正なCPU保存を破棄し、同じAlarmで着手・再選択しない (%s)", async (condition) => {
  const { stub, at, before } = await setup("singles", condition === "レベル" ? 2 : 1);
  await runInDurableObject(stub, async (instance, ctx) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
    try {
      await instance.alarm();
      const job = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
      const changed: FourReversiCpuJob = { ...job };
      if (condition === "部屋世代") changed.instanceId = "old";
      if (condition === "別局") changed.roundId = "old";
      if (condition === "本人") changed.playerId = "old";
      if (condition === "色") changed.color = job.color === "black" ? "white" : "black";
      if (condition === "レベル") changed.level = job.level === 1 ? 2 : 1;
      if (condition === "時計") changed.turnStartedAt--;
      if (condition === "不正手") changed.move = { x: 3, y: 3 };
      if (condition === "不正時刻") changed.applyAt = NaN;
      ctx.storage.kv.put(fourReversiCpuJobKey, condition === "壊れたジョブ" ? null : changed);
      let game = before.game;
      if (condition === "盤面") {
        game = structuredClone(game);
        [game.board[3][3], game.board[3][4]] = [game.board[3][4], game.board[3][3]];
      }
      if (condition === "手番外脱落") {
        const other = before.players.find((p) => p.color !== game.turn)!;
        const result = eliminateColor(game, other.color);
        if (!result.ok || result.state.status !== "playing") throw Error("Expected playing");
        const parsed = fourReversiStateSchema.parse(result.state);
        if (parsed.status !== "playing") throw Error("Expected playing");
        game = parsed;
      }
      ctx.storage.kv.put("room", { ...before, game });
      clock.mockReturnValue(at + 2001);
      await instance.alarm();
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
      expect(fourReversiRoomSchema.parse(ctx.storage.kv.get("room")).game).toEqual(game);
      expect(roundReplaySchema.parse(ctx.storage.kv.get("round-replay")).steps).toHaveLength(0);
      await instance.alarm();
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeDefined();
      expect(fourReversiRoomSchema.parse(ctx.storage.kv.get("room")).game).toEqual(game);
      await ctx.storage.setAlarm(at + 60_000);
    } finally {
      clock.mockRestore();
    }
  });
});

test.each(["計算後に期限", "期限同時刻", "復帰期限が先"])(
  "保存後の期限を着手より優先する (%s)",
  async (condition) => {
    const { stub, at, before, entry } = await setup(
      "singles",
      condition === "計算後に期限" ? 2 : 1,
    );
    await runInDurableObject(stub, async (instance, ctx) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
      try {
        await instance.alarm();
        const job = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
        const atDeadline = condition === "期限同時刻" ? job.applyAt : at + 2002;
        const room = { ...before, clock: { ...before.clock, turnExpiresAt: atDeadline } };
        if (condition === "復帰期限が先") {
          room.clock.turnExpiresAt = at + 300_000;
          const human = room.players.find((p) => p.kind === "human")!;
          human.reconnectDeadline = atDeadline;
        }
        ctx.storage.kv.put("room", room);
        clock.mockReturnValue(atDeadline);
        await instance.alarm();
        if (condition === "復帰期限が先") {
          expect(ctx.storage.kv.get("room")).toBeUndefined();
          expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
          return;
        }
        const after = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
        expect(after.game?.moveNumber).toBe(0);
        expect(after.game?.eliminatedColors).toHaveLength(1);
        expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
        expect(
          roundReplaySchema.parse(ctx.storage.kv.get("round-replay")).steps[0].action.type,
        ).toBe("eliminate");
        await ctx.storage.setAlarm(at + 60_000);
      } finally {
        clock.mockRestore();
      }
    });
    if (condition === "復帰期限が先") fixtures.forgetClosedRoom(entry.room.id);
  },
);

test("記録導入前のDOもジョブなしから進め、適用失敗のtransactionはジョブ・盤面・棋譜を戻す", async () => {
  const { stub, at } = await setup();
  await runInDurableObject(stub, async (_, ctx) => {
    ctx.storage.kv.delete(matchStartKey);
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      membership: () => null,
      accountId: () => null,
    });
    const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error("Expected playing");
    const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
    try {
      expect(progress.cpu(room, Date.now()).kind).toBe("unchanged");
      const job = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
      expect(job.roundId).toBeNull();
      const replay = ctx.storage.kv.get("round-replay");
      clock.mockReturnValue(at + 2001);
      expect(() =>
        ctx.storage.transactionSync(() => {
          const result = progress.cpu(room, Date.now());
          expect(result.kind).toBe("playing");
          if (result.kind === "playing") ctx.storage.kv.put("room", result.room);
          throw Error("保存失敗");
        }),
      ).toThrow("保存失敗");
      expect(ctx.storage.kv.get("room")).toEqual(room);
      expect(ctx.storage.kv.get("round-replay")).toEqual(replay);
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toEqual(job);
      expect(progress.cpu(room, Date.now()).kind).toBe("playing");
      expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: Lv2の全読み着手で終局し、次局開始でも旧ジョブを破棄する`, async () => {
    const { stub, at, before } = await setup(mode, 2);
    await runInDurableObject(stub, async (instance, ctx) => {
      const board = Array.from({ length: 8 }, () =>
        Array<"black" | "white" | "red" | "blue" | null>(8).fill("black"),
      );
      board[0][1] = "white";
      board[0][2] = null;
      board[2][1] = "red";
      board[4][1] = "blue";
      board[3][1] = "white";
      board[7][7] = null;
      const cpu = before.players.find((p) => p.kind === "cpu")!;
      const players = before.players.map((p) => ({
        ...p,
        color: p.id === cpu.id ? "black" : p.color === "black" ? cpu.color : p.color,
      }));
      const room = fourReversiRoomSchema.parse({
        ...before,
        players,
        game: { ...before.game, board, turn: "black" },
      });
      ctx.storage.kv.put("room", room);
      const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
      try {
        await instance.alarm();
        const job = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
        expect(job.move).toEqual({ x: 2, y: 0 });
        clock.mockReturnValue(at + 2001);
        await instance.alarm();
        const waiting = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
        expect(waiting.status).toBe("waiting");
        expect(waiting.lastRound?.game.result.reason).toBe("all_passed");
        expect(waiting.lastRound?.game.board[7][7]).toBeNull();
        expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
        if (waiting.status !== "waiting") throw Error("Expected waiting");
        const progress = new FourReversiProgress({
          storage: ctx.storage,
          membership: () => null,
          accountId: () => null,
        });
        ctx.storage.kv.put(fourReversiCpuJobKey, job);
        const started = progress.start(waiting);
        expect(started.roundId).not.toBe(job.roundId);
        expect(started.room.game.moveNumber).toBe(0);
        expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toBeUndefined();
        await ctx.storage.setAlarm(at + 60_000);
      } finally {
        clock.mockRestore();
      }
    });
  });
}

test("チャットで保存した選択・盤面・手番開始を変えない", async () => {
  const { stub, host } = await setup();
  const selected = await runInDurableObject(stub, async (instance, ctx) => {
    const room = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (room.status !== "playing") throw Error("Expected playing");
    room.clock.turnStartedAt = Date.now() - 3000;
    room.clock.turnExpiresAt = Date.now() + 300000;
    ctx.storage.kv.put("room", room);
    await instance.alarm();
    const job = ctx.storage.kv.get<FourReversiCpuJob>(fourReversiCpuJobKey)!;
    const saved = { ...job, applyAt: Date.now() + 60000 };
    ctx.storage.kv.put(fourReversiCpuJobKey, saved);
    await ctx.storage.setAlarm(saved.applyAt);
    return { job: saved, game: room.game, at: room.clock.turnStartedAt };
  });
  host.send({ type: "room.chat.send", text: "CPUの思考中です" });
  await host.waitFor("room.chat.snapshot", (m) =>
    m.messages.some((v) => v.text === "CPUの思考中です"),
  );
  await runInDurableObject(stub, async (instance, ctx) => {
    const room = await instance.getRoom();
    expect(ctx.storage.kv.get(fourReversiCpuJobKey)).toEqual(selected.job);
    expect(room?.game).toEqual(selected.game);
    expect(room?.clock?.turnStartedAt).toBe(selected.at);
    expect(await ctx.storage.getAlarm()).toBe(selected.job.applyAt);
  });
});
