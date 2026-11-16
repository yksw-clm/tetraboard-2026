import { expect, test } from "bun:test";
import type { Room } from "@tetraboard/protocol";
import { processDeadlines, roomIdleMs, type PlayingFor } from "../src";
import { MemoryPorts, human, now, playing, waiting } from "./memoryPorts";

function run(m: MemoryPorts, applyCpu = false, at = now) {
  return m.run((op) => processDeadlines(op, m.room, applyCpu), at);
}
function readyPlaying() {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = playing();
  return m;
}

test("ルーム不在は保存も効果も返さない", () => {
  const m = new MemoryPorts();
  m.room = null;
  expect(run(m)).toEqual({ value: { room: null, changed: false, notifications: [] }, effects: [] });
  expect(m.calls).toEqual([]);
});

test.each([roomIdleMs - 1, roomIdleMs])("無操作の期限の境界 %i", (elapsed) => {
  const m = new MemoryPorts();
  const result = run(m, false, 10 + elapsed);
  expect(result.value.room === null).toBe(elapsed === roomIdleMs);
  expect(result.value.notifications.map((e) => e.type)).toEqual(
    elapsed === roomIdleMs ? ["closeSockets"] : [],
  );
  expect(result.effects.map((e) => e.type)).toEqual(elapsed === roomIdleMs ? ["usage"] : []);
});

test("無操作の期限を使わないゲームと人間不在の継続方針を守る", () => {
  const m = new MemoryPorts();
  m.adapter.cpu.usesIdleDeadline = () => false;
  m.keepWithoutHumans = true;
  m.tokens.clear();
  expect(run(m, false, now + roomIdleMs).value.room).toBe(m.room!);
  m.keepWithoutHumans = false;
  expect(run(m).value.notifications).toEqual([{ type: "closeSockets" }]);
  expect(m.room).toBeNull();
});

test("大会の開始待ちは接続が欠けたときだけ外し、公開更新時刻を進める", () => {
  const m = new MemoryPorts();
  m.room = { ...waiting(), tournamentStartsAtMs: now + 1000 } as Room;
  m.state.waitingTournament = () => ({ expiresAt: now + 60_000, connected: true });
  // 人数の条件を満たす席を用意します。ゲーム固有の接続判定はポートの責務です。
  m.room = { ...m.room, players: [human("host"), human("b"), human("c"), human("d")] } as Room;
  expect(run(m).value.changed).toBe(false);
  m.state.waitingTournament = () => ({ expiresAt: now + 60_000, connected: false });
  const result = run(m);
  expect(result.value.room).not.toHaveProperty("tournamentStartsAtMs");
  expect(result.value.room?.publicUpdatedAtMs).toBe(now);
  expect(result.value.notifications).toEqual([{ type: "broadcastRoom", room: m.room! }]);
});

test.each(["期限", "人数"])("大会の %s の条件で閉鎖し、後続を処理しない", (condition) => {
  const m = new MemoryPorts();
  m.state.waitingTournament = () => ({
    expiresAt: condition === "期限" ? now : now + 1,
    connected: false,
  });
  if (condition === "期限")
    m.room = {
      ...waiting(),
      players: Array.from({ length: 4 }, (_, i) => human(i ? `${i}` : "host")),
    } as Room;
  m.state.registrationDeadline = () => {
    throw new Error("後続を呼んではいけません");
  };
  expect(run(m).value.notifications).toEqual([{ type: "closeSockets" }]);
  expect(m.calls).toContain("closeReservations");
});

test.each([now - 1, now, now + 1])("登録の保持期限 %i を席と同期する", (deadline) => {
  const m = new MemoryPorts();
  let hold: number | undefined = deadline;
  const expired: string[] = [];
  m.state.registrationDeadline = () => hold;
  m.state.expireRegistration = (id) => {
    expired.push(id);
    hold = undefined;
  };
  const result = run(m);
  expect(expired).toEqual(deadline <= now ? ["host"] : []);
  expect(registrationHold(result.value.room)).toBe(deadline > now ? deadline : undefined);
  expect(result.value.changed).toBe(true);
});

test("期限切れの登録表示を消し、保持中は切断の期限到来を保留する", () => {
  const m = new MemoryPorts();
  m.room = {
    ...waiting(),
    players: [
      { ...human("host"), reconnectDeadline: now - 1, registrationPendingUntilMs: now + 1 },
    ],
  };
  m.state.registrationDeadline = () => now + 1;
  expect(run(m).value.changed).toBe(false);
  m.room = { ...waiting(), players: [{ ...human("host"), registrationPendingUntilMs: now - 1 }] };
  expect(registrationHold(run(m).value.room)).toBe(now + 1);
  m.state.registrationDeadline = () => undefined;
  expect(run(m).value.room?.players[0]).not.toHaveProperty("registrationPendingUntilMs");
});

test.each([undefined, now - 10_000])(
  "切断時刻 %s から30秒の期限を付け、一度付けた期限を保つ",
  (at) => {
    const m = new MemoryPorts();
    m.connections.clear();
    if (at !== undefined) m.disconnected.set("host", at);
    const result = run(m);
    const deadline = (at ?? now) + 30_000;
    expect(m.disconnected.get("host")).toBe(at ?? now);
    expect(result.value.room?.players[0].reconnectDeadline).toBe(deadline);
    expect(run(m, false, now + 1).value.changed).toBe(false);
    expect(m.room?.players[0].reconnectDeadline).toBe(deadline);
  },
);

test("接続中、退会済み、既に期限のある席に新しい切断期限を付けない", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.departed.add("guest");
  m.connections.delete("guest-token");
  expect(run(m).value.changed).toBe(false);
  expect(m.disconnected.size).toBe(0);
  m.room = { ...waiting(), players: [{ ...human("host"), reconnectDeadline: now + 1 }] };
  m.connections.clear();
  expect(run(m).value.changed).toBe(false);
});

test("待機中のホストの切断期限は配信の後に後継者の資格を通知する", () => {
  const m = new MemoryPorts();
  m.addGuest();
  m.room = {
    ...waiting(),
    players: [{ ...human("host"), reconnectDeadline: now }, human("guest")],
  };
  const result = run(m);
  expect(m.room?.players.map((p) => p.id)).toEqual(["guest"]);
  expect(m.memberships.get("guest-token")?.role).toBe("host");
  expect(result.value.notifications).toEqual([
    { type: "broadcastRoom", room: m.room! },
    { type: "sendMembership", tokenHash: "guest-token" },
  ]);
  expect(result.effects).toEqual([{ type: "chatChanged" }]);
});

test("最後の人間の切断期限で閉鎖する", () => {
  const m = new MemoryPorts();
  m.room = { ...waiting(), players: [{ ...human("host"), reconnectDeadline: now }] };
  expect(run(m).value.notifications).toEqual([{ type: "closeSockets" }]);
  expect(m.room).toBeNull();
});

function deadlineOrder(clockAt: number, disconnectAt: number) {
  const m = readyPlaying();
  const room = playing();
  m.room = {
    ...room,
    clock: { ...room.clock, turnExpiresAt: clockAt },
    players: room.players.map((p) =>
      p.kind === "human" ? { ...p, reconnectDeadline: disconnectAt } : p,
    ),
  };
  const calls: string[] = [];
  m.adapter.cpu.timeout = (current, at) => {
    calls.push(`timeout:${at}`);
    return {
      kind: "playing",
      gameId: "reversi",
      room: {
        ...current,
        clock: { ...current.clock, turnStartedAt: now, turnExpiresAt: now + 60_000 },
      },
    };
  };
  m.adapter.cpu.disconnect = (current, id, at) => {
    calls.push(`${id}:${at}`);
    return {
      kind: "playing",
      gameId: "reversi",
      room: {
        ...current,
        players: current.players.map((p) => (p.id === id ? { ...p, reconnectDeadline: null } : p)),
      },
    };
  };
  m.keepWithoutHumans = true;
  run(m);
  return { m, calls };
}

test("同時刻は時間切れが先、切断同士はプレイヤーの並び順", () => {
  const { calls, m } = deadlineOrder(now, now);
  expect(calls).toEqual([`timeout:${now}`, `host:${now}`, `guest:${now}`]);
  expect(m.released).toEqual([
    ["host", false],
    ["guest", false],
  ]);
  expect(m.departed).toEqual(new Set(["host", "guest"]));
});

test("期限は早い順に処理し、一つ処理するたび時計と切断期限を選び直す", () => {
  expect(deadlineOrder(now, now - 1).calls).toEqual([
    `host:${now - 1}`,
    `guest:${now - 1}`,
    `timeout:${now}`,
  ]);
  const m = readyPlaying();
  const room = playing();
  m.room = {
    ...room,
    clock: { ...room.clock, turnExpiresAt: now },
    players: room.players.map((p) => (p.kind === "human" ? { ...p, reconnectDeadline: now } : p)),
  };
  m.adapter.cpu.timeout = (current) => ({
    kind: "playing",
    gameId: "reversi",
    room: {
      ...current,
      clock: { ...current.clock, turnExpiresAt: now + 1 },
      players: current.players.map((p) =>
        p.kind === "human" ? { ...p, reconnectDeadline: now + 1 } : p,
      ),
    },
  });
  m.adapter.cpu.disconnect = () => {
    throw new Error("更新前の切断期限を使ってはいけません");
  };
  expect(run(m).value.changed).toBe(true);
});

test.each([
  [false, 2000, 1, 0],
  [true, 1999, 1, 0],
  [true, 2000, 1, 1],
  [true, 2000, 0, 0],
] as const)(
  "CPU は Alarm=%s、待機%i ms、時計の残り%i ms で%i回進める",
  (applyCpu, elapsed, remaining, expected) => {
    const m = readyPlaying();
    const room = playing();
    m.room = {
      ...room,
      clock: { ...room.clock, turnStartedAt: now - elapsed, turnExpiresAt: now + remaining },
    };
    let calls = 0;
    m.adapter.cpu.step = (current) => {
      calls++;
      return { room: current };
    };
    m.adapter.cpu.timeout = (current) => ({
      kind: "playing",
      gameId: "reversi",
      room: { ...current, clock: { ...current.clock, turnStartedAt: now, turnExpiresAt: now + 1 } },
    });
    run(m, applyCpu);
    expect(calls).toBe(expected);
  },
);

test("CPU の進行を保存して効果を返し、外部要求と確定後の処理は実行しない", () => {
  const m = readyPlaying();
  const room = playing();
  m.room = { ...room, clock: { ...room.clock, turnStartedAt: now - 2000 } };
  const external = { opaque: "request" };
  const afterTransaction = () => {
    throw new Error("use-case から実行してはいけません");
  };
  m.state.hasCpuCapacity = () => false;
  m.adapter.cpu.step = (current, context) => {
    expect(context.now).toBe(now);
    expect(context.hasCapacity(current)).toBe(false);
    const updated: PlayingFor<"reversi"> = { ...current, positionRevision: 2 };
    return {
      room: context.applyProgress({ kind: "playing", gameId: "reversi", room: updated }),
      external,
      afterTransaction,
    };
  };
  const result = run(m, true);
  expect(result.value.room).toMatchObject({ positionRevision: 2 });
  expect(result.value.external).toBe(external);
  expect(result.value.afterTransaction).toBe(afterTransaction);
  expect(result.value.notifications).toEqual([{ type: "broadcastRoom", room: m.room! }]);
  expect(m.calls).toContain("saveRoom");
});

function registrationHold(room: Room | null) {
  const player = room?.players[0];
  return player?.kind === "human" ? player.registrationPendingUntilMs : undefined;
}
