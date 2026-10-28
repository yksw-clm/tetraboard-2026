import { describe, expect, test } from "bun:test";
import { createInitialState, getLegalActions, type FourShogiState } from "@tetraboard/four-shogi";
import { applyReplayEvent } from "@tetraboard/four-shogi/replay";
import { restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import {
  fourShogiRoomSchema,
  type FourShogiReplayEvent,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import {
  initialShogiState,
  playingShogiRoom,
  publicShogiState,
  waitingShogiRoom,
} from "../../web/test/fixtures/fourShogiFixtures";
import {
  liveReplayTarget,
  restoreLiveReplay,
  type VerifiedLiveUpdate,
} from "../src/domain/liveReplay";
import {
  createLiveRoomSession,
  liveRoomLocation,
  type LiveRoomStatus,
} from "../src/server/liveRoom";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const root = initialShogiState();
  const initial = {
    mode: "singles" as const,
    players: root.players,
    threePlayerAttackProhibited: true,
  };
  const states: FourShogiState[] = [createInitialState(initial)];
  const events: { index: number; event: FourShogiReplayEvent }[] = [];
  const append = (event: FourShogiReplayEvent) => {
    const next = applyReplayEvent(states.at(-1)!, event);
    if (!next.ok) throw new Error(next.reason);
    events.push({ index: events.length, event });
    states.push(next.state);
  };
  append({ type: "drawProposal", side: "south", proposed: true });
  append({ type: "drawProposal", side: "south", proposed: false });
  for (let index = 0; index < 4; index++) {
    const state = states.at(-1)!;
    append({ type: "action", side: state.turn!, action: getLegalActions(state)[0] });
  }
  append({ type: "eliminate", side: "east", reason: "disconnected" });
  append({ type: "eliminate", side: "north", reason: "timeout" });
  append({ type: "eliminate", side: "west", reason: "left" });
  const base = playingShogiRoom();
  const roundId = base.roundId;
  function roomAt(eventCount: number, id = roundId): FourShogiRoom {
    const state = states[eventCount];
    if (state.status === "playing") return { ...playingShogiRoom(state, eventCount), roundId: id };
    return fourShogiRoomSchema.parse({
      ...waitingShogiRoom(),
      lastRound: {
        roundId: id,
        eventCount,
        game: publicShogiState(state),
        players: base.players.map(({ id: playerId, name, side }) => ({ id: playerId, name, side })),
      },
    });
  }
  const page = (cursor: number, through: number, id = roundId) => ({
    instanceId: base.instanceId,
    roundId: id,
    rulesVersion: 1,
    initial,
    eventCount: through,
    events: events.slice(cursor, Math.min(cursor + 100, through)),
    nextCursor: cursor + 100 < through ? cursor + 100 : null,
  });
  const snapshot = (room: FourShogiRoom) => ({
    room,
    presence: { connectedPlayerIds: [], hostPlayerId: base.players[0].id },
    serverNowMs: 1700000000000,
  });
  const detail = {
    id: roundId,
    roomId: base.id,
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: base.settings,
    participants: base.players.map(({ id, name, side }, seat) => ({
      id,
      name,
      side,
      seat,
      kind: "human",
      avatarUrl: null,
    })),
    game: publicShogiState(states.at(-1)!),
    knockouts: { south: 0, west: 0, north: 0, east: 0 },
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  };
  return { initial, states, events, base, roundId, roomAt, page, snapshot, detail };
}

class FakeSocket extends EventTarget {
  closed = false;
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function harness() {
  const data = fixture();
  let room: FourShogiRoom | null = data.roomAt(3);
  let prefixStatus = 200;
  let archiveStatus = 200;
  let held: {
    count: number;
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const sockets: FakeSocket[] = [];
  const socketWaiters: ((socket: FakeSocket) => void)[] = [];
  const updates: VerifiedLiveUpdate[] = [];
  const updateWaiters: ((update: VerifiedLiveUpdate) => void)[] = [];
  const statuses: LiveRoomStatus[] = [];
  const statusWaiters: {
    predicate: (status: LiveRoomStatus) => boolean;
    resolve: (status: LiveRoomStatus) => void;
  }[] = [];
  const scheduled: (() => void)[] = [];
  const timerWaiters: ((callback: () => void) => void)[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === `/api/rooms/${data.base.id}`)
      return room ? Response.json(data.snapshot(room)) : new Response(null, { status: 404 });
    if (url.pathname.endsWith("/replay") && url.pathname.includes("/rounds/")) {
      if (prefixStatus !== 200) return new Response(null, { status: prefixStatus });
      const count = Number(url.searchParams.get("throughEventCount"));
      if (held?.count === count) {
        held.entered.resolve();
        await held.release.promise;
      }
      const id = url.pathname.split("/").at(-2)!;
      return Response.json(data.page(Number(url.searchParams.get("cursor")), count, id));
    }
    if (url.pathname === `/api/matches/${data.roundId}`)
      return archiveStatus === 200
        ? Response.json({ match: data.detail })
        : new Response(null, { status: archiveStatus });
    if (url.pathname === `/api/matches/${data.roundId}/replay`)
      return Response.json({
        matchId: data.roundId,
        rulesVersion: 1,
        initial: data.initial,
        eventCount: data.events.length,
        events: data.events,
        nextCursor: null,
      });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const session = createLiveRoomSession(
    `https://tetraboard.net/rooms/${data.base.id}`,
    {
      onUpdate(update) {
        updates.push(update);
        updateWaiters.shift()?.(update);
      },
      onStatus(status) {
        statuses.push(status);
        for (let index = statusWaiters.length - 1; index >= 0; index--) {
          const waiter = statusWaiters[index];
          if (waiter.predicate(status)) {
            statusWaiters.splice(index, 1);
            waiter.resolve(status);
          }
        }
      },
    },
    {
      fetch: fetcher,
      createWebSocket(url) {
        expect(url).toContain(
          `wss://tetraboard.net/api/rooms/${data.base.id}/ws?instanceId=${data.base.instanceId}`,
        );
        const socket = new FakeSocket();
        sockets.push(socket);
        socketWaiters.shift()?.(socket);
        return socket as unknown as WebSocket;
      },
      schedule(callback) {
        scheduled.push(callback);
        timerWaiters.shift()?.(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule() {},
    },
  );
  return {
    ...data,
    session,
    requests,
    sockets,
    updates,
    statuses,
    scheduled,
    setRoom(value: FourShogiRoom | null) {
      room = value;
    },
    setPrefixStatus(value: number) {
      prefixStatus = value;
    },
    setArchiveStatus(value: number) {
      archiveStatus = value;
    },
    hold(count: number) {
      held = { count, entered: deferred<void>(), release: deferred<void>() };
      return held;
    },
    socket() {
      return new Promise<FakeSocket>((resolve) => socketWaiters.push(resolve));
    },
    nextUpdate() {
      return new Promise<VerifiedLiveUpdate>((resolve) => updateWaiters.push(resolve));
    },
    nextStatus(predicate: (status: LiveRoomStatus) => boolean) {
      return new Promise<LiveRoomStatus>((resolve) => statusWaiters.push({ predicate, resolve }));
    },
    nextTimer() {
      return new Promise<() => void>((resolve) => timerWaiters.push(resolve));
    },
    send(socket: FakeSocket, room: FourShogiRoom) {
      socket.message({ type: "room.snapshot", ...data.snapshot(room) });
    },
  };
}

describe("ライブ棋譜の完全状態復元", () => {
  test("途中局面から完全履歴を復元し、差分でも反復辞書と攻撃履歴を保つ", async () => {
    const data = fixture();
    const target = liveReplayTarget(data.roomAt(3))!;
    const first = await restoreLiveReplay(
      "https://tetraboard.net/rooms/12345",
      target,
      async (cursor) => data.page(cursor, 3),
    );
    expect(first.position.state).toEqual(data.states[3]);
    const cursors: number[] = [];
    const next = await restoreLiveReplay(
      first.sourceUrl,
      liveReplayTarget(data.roomAt(7))!,
      async (cursor) => {
        cursors.push(cursor);
        return data.page(cursor, 7);
      },
      first,
    );
    expect(cursors).toEqual([3]);
    expect(next.position.state).toEqual(data.states[7]);
    expect(next.replay.events).toHaveLength(7);
    const full = await restoreAnalysisPosition(next.replay);
    expect(next.position.stateHash).toBe(full.stateHash);
  });

  test("異なる局・更新数・連番・同じrevisionの異なる盤面を拒否する", async () => {
    const data = fixture();
    const target = liveReplayTarget(data.roomAt(3))!;
    for (const page of [
      { ...data.page(0, 3), roundId: crypto.randomUUID() },
      { ...data.page(0, 3), eventCount: 4 },
      { ...data.page(0, 3), events: data.page(0, 3).events.slice(1) },
    ])
      await expect(restoreLiveReplay("source", target, async () => page)).rejects.toThrow();
    const other = { ...target, game: publicShogiState(data.states[4]) };
    await expect(restoreLiveReplay("source", other, async () => data.page(0, 3))).rejects.toThrow(
      "一致しません",
    );
  });

  test("100件を超えるprefixは同じ終端で全ページを照合する", async () => {
    const data = fixture();
    let state = createInitialState(data.initial);
    const events: { index: number; event: FourShogiReplayEvent }[] = [];
    for (let index = 0; index < 105; index++) {
      const event = {
        type: "drawProposal" as const,
        side: "south" as const,
        proposed: index % 2 === 0,
      };
      const next = applyReplayEvent(state, event);
      if (!next.ok) throw new Error(next.reason);
      events.push({ index, event });
      state = next.state;
    }
    const room = playingShogiRoom(state, events.length);
    const target = liveReplayTarget(room)!;
    const cursors: number[] = [];
    const restored = await restoreLiveReplay("source", target, async (cursor) => {
      cursors.push(cursor);
      return {
        instanceId: room.instanceId,
        roundId: room.roundId,
        rulesVersion: 1,
        initial: data.initial,
        eventCount: events.length,
        events: events.slice(cursor, cursor + 100),
        nextCursor: cursor + 100 < events.length ? cursor + 100 : null,
      };
    });
    expect(cursors).toEqual([0, 100]);
    expect(restored.position.state).toEqual(state);
  });
});

describe("観戦WSと固定prefixの同期", () => {
  test("最初のsnapshotと完全履歴を照合してから公開し、更新は差分で取得する", async () => {
    const h = harness();
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    const first = await started;
    expect(first.eventCount).toBe(3);
    expect(first.position.state).toEqual(h.states[3]);
    const changed = h.nextUpdate();
    h.send(socket, h.roomAt(6));
    expect((await changed).position.state).toEqual(h.states[6]);
    const pages = h.requests.filter(({ url }) => url.pathname.includes("/rounds/"));
    expect(
      pages.map(({ url }) => [
        url.searchParams.get("cursor"),
        url.searchParams.get("throughEventCount"),
      ]),
    ).toEqual([
      ["0", "3"],
      ["3", "6"],
    ]);
    expect(
      h.requests.every(({ init }) => init?.credentials === "omit" && init.redirect === "error"),
    ).toBe(true);
    h.session.close();
  });

  test("取得中の新着snapshotへcatchupし、再接続でも初期から作り直さない", async () => {
    const h = harness();
    const held = h.hold(3);
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    await held.entered.promise;
    const later = h.nextUpdate();
    h.send(socket, h.roomAt(5));
    held.release.resolve();
    await started;
    await later;
    if (h.updates.at(-1)?.eventCount !== 5) await h.nextUpdate();
    expect(h.updates.at(-1)?.eventCount).toBe(5);
    h.setRoom(h.roomAt(7));
    const nextSocket = h.socket();
    await h.session.reconnect();
    const reconnected = await nextSocket;
    const changed = h.nextUpdate();
    h.send(reconnected, h.roomAt(7));
    const update = await changed;
    expect(update.position.state).toEqual(h.states[7]);
    expect(
      h.requests
        .filter(({ url }) => url.pathname.includes("/rounds/"))
        .at(-1)
        ?.url.searchParams.get("cursor"),
    ).toBe("5");
    h.session.close();
  });

  test("再接続前の遅延応答を破棄し、部屋番号の世代変更を拒否する", async () => {
    const h = harness();
    const held = h.hold(3);
    const socketReady = h.socket();
    const started = h.session.start();
    const old = await socketReady;
    h.send(old, h.roomAt(3));
    await held.entered.promise;
    h.setRoom(h.roomAt(5));
    const socketAgain = h.socket();
    await h.session.reconnect();
    const socket = await socketAgain;
    h.send(socket, h.roomAt(5));
    held.release.resolve();
    expect((await started).eventCount).toBe(5);
    expect(h.updates.map((update) => update.eventCount)).toEqual([5]);
    h.setRoom({ ...h.roomAt(6), instanceId: crypto.randomUUID() });
    await h.session.reconnect();
    expect(h.statuses.at(-1)?.state).toBe("error");
    expect(h.statuses.at(-1)?.message).toContain("世代");
    h.session.close();
  });

  test("終局snapshotで最終履歴を確定し、同じ部屋の次局を別の履歴として取得する", async () => {
    const h = harness();
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    await started;
    const ended = h.nextUpdate();
    h.send(socket, h.roomAt(h.events.length));
    expect((await ended).finished).toBe(true);
    const nextRoundId = crypto.randomUUID();
    const changed = h.nextUpdate();
    h.send(socket, h.roomAt(2, nextRoundId));
    const next = await changed;
    expect(next.roundId).toBe(nextRoundId);
    expect(next.replay.events).toHaveLength(2);
    expect(
      h.requests
        .filter(({ url }) => url.pathname.includes(nextRoundId))
        .at(-1)
        ?.url.searchParams.get("cursor"),
    ).toBe("0");
    h.session.close();
  });

  test("部屋閉鎖後は保存棋譜と既知prefixを照合して終局まで復元する", async () => {
    const h = harness();
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(6));
    await started;
    h.setRoom(null);
    const ended = h.nextUpdate();
    await h.session.reconnect();
    const final = await ended;
    expect(final.finished).toBe(true);
    expect(final.position.state).toEqual(h.states.at(-1)!);
    expect(h.statuses.at(-1)?.state).toBe("finished");
    h.session.close();
  });

  test("最初の履歴取得前に部屋が閉じても観戦した局面と保存棋譜を照合する", async () => {
    const h = harness();
    h.setPrefixStatus(404);
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    const final = await started;
    expect(final.finished).toBe(true);
    expect(final.position.state).toEqual(h.states.at(-1)!);
    expect(h.updates).toHaveLength(1);
    h.session.close();
  });

  test("旧Workerが固定prefixを拒否した場合は完全解析を開始しない", async () => {
    const h = harness();
    h.setPrefixStatus(400);
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    await expect(started).rejects.toThrow();
    expect(h.updates).toEqual([]);
    expect(h.statuses.at(-1)?.message).toContain("API配信後");
    h.session.close();
  });

  test("開始前の部屋は明示エラーを返し、初回snapshotの待機は30秒で終了する", async () => {
    const waiting = harness();
    waiting.setRoom(waitingShogiRoom());
    await expect(waiting.session.start()).rejects.toThrow("対局開始後");
    expect(waiting.updates).toEqual([]);
    waiting.session.close();
    const missing = harness();
    const socketReady = missing.socket();
    const started = missing.session.start();
    const socket = await socketReady;
    missing.scheduled[0]();
    await expect(started).rejects.toThrow("30秒");
    missing.send(socket, missing.roomAt(3));
    expect(missing.updates).toEqual([]);
    missing.session.close();
  });

  test("閉鎖後に終局棋譜を取得できない場合は5回で自動再接続を止める", async () => {
    const h = harness();
    const socketReady = h.socket();
    const started = h.session.start();
    const socket = await socketReady;
    h.send(socket, h.roomAt(3));
    await started;
    h.setRoom(null);
    h.setArchiveStatus(503);
    const firstTimer = h.nextTimer();
    await h.session.reconnect();
    let timer = await firstTimer;
    const finalError = h.nextStatus((status) => status.state === "error");
    for (let attempt = 0; attempt < 4; attempt++) {
      const nextTimer = h.nextTimer();
      timer();
      timer = await nextTimer;
    }
    timer();
    expect((await finalError).message).toContain("履歴を確定できませんでした");
    expect(h.updates).toHaveLength(1);
    h.session.close();
  });
});

test("観戦URLは公開先に限定し、localhostは明示許可した場合だけ使える", () => {
  expect(liveRoomLocation("https://tetraboard.net/rooms/12345").roomId).toBe("12345");
  expect(() => liveRoomLocation("http://127.0.0.1:8787/rooms/12345")).toThrow();
  expect(
    liveRoomLocation("http://127.0.0.1:8787/rooms/12345", ["http://127.0.0.1:8787"]).origin,
  ).toBe("http://127.0.0.1:8787");
  for (const url of [
    "https://untrusted.test/rooms/12345",
    "https://user@tetraboard.net/rooms/12345",
    "https://tetraboard.net/rooms/12345?token=secret",
    "https://tetraboard.net/rooms/12345?instanceId=no",
  ])
    expect(() => liveRoomLocation(url)).toThrow();
});
