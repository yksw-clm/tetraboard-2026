import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInitialState } from "@tetraboard/four-reversi";
import { fourReversiRoomSchema, fourShogiRoomSchema } from "@tetraboard/protocol";
import { WidgetController } from "../src/controller";
import { observationSchema, type ContinuousRequest } from "../src/model";
import { playerId, progressFor, shogiObservation, settle } from "./fixtures";
const script = await Bun.file(new URL("../dist/bridge.js", import.meta.url)).text();
function fixture(response: unknown = snapshot()) {
  const w = new Window({ url: "https://tetraboard.net/rooms/12345" });
  const sent: unknown[] = [];
  const failure = Error("native failure");
  const sockets: FakeSocket[] = [];
  class FakeSocket extends w.EventTarget {
    static OPEN = 1;
    constructor(
      public url: string,
      public protocols?: string[],
    ) {
      super();
      if (url === "invalid") throw failure;
      sockets.push(this);
    }
    send(value: string) {
      sent.push(value);
    }
    open() {
      this.dispatchEvent(new w.Event("open"));
    }
    receive(value: unknown) {
      this.dispatchEvent(new w.MessageEvent("message", { data: JSON.stringify(value) }));
    }
    close() {
      this.dispatchEvent(new w.Event("close"));
    }
  }
  const observations: unknown[] = [];
  const promise = Promise.resolve(Response.json(response));
  const nativeFetch = () => promise;
  Object.assign(w, { WebSocket: FakeSocket, fetch: nativeFetch });
  w.postMessage = ((message: unknown) => observations.push(message)) as typeof w.postMessage;
  w.eval(script);
  return { w, sockets, observations, FakeSocket, promise, failure };
}
function snapshot() {
  const ids = [1, 2, 3, 4].map((i) => `00000000-0000-4000-8000-00000000000${i}`);
  return {
    type: "room.snapshot",
    serverNowMs: 100,
    presence: { hostPlayerId: playerId, connectedPlayerIds: ids },
    room: {
      id: "12345",
      instanceId: "00000000-0000-4000-8000-000000000010",
      status: "playing",
      roundId: "00000000-0000-4000-8000-000000000020",
      positionRevision: 3,
      settings: {
        game: "four-reversi",
        mode: "singles",
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
      },
      publicUpdatedAtMs: 100,
      lastActivityAtMs: 100,
      players: ids.map((id, i) => ({
        id,
        name: "private",
        kind: "human",
        ready: true,
        color: ["black", "white", "red", "blue"][i],
        reconnectDeadline: null,
      })),
      game: createInitialState("singles"),
      clock: {
        remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
        turnStartedAt: 100,
        turnExpiresAt: 330100,
      },
      lastRound: null,
    },
  };
}
test("既存WebSocketの引数・型・例外を保ち、受信した本人と局面だけを通知する", async () => {
  const f = fixture();
  try {
    const ws = new f.w.WebSocket("wss://tetraboard.net/api/rooms/12345/ws?instanceId=x", ["test"]);
    expect(ws).toBeInstanceOf(f.FakeSocket);
    expect(f.w.WebSocket.OPEN).toBe(1);
    expect(f.sockets[0].protocols).toEqual(["test"]);
    f.sockets[0].open();
    const parsed = fourReversiRoomSchema.safeParse(snapshot().room);
    if (!parsed.success) throw parsed.error;
    f.sockets[0].receive(snapshot());
    f.sockets[0].receive({ type: "room.authenticated", membership: { playerId, role: "host" } });
    expect(f.observations.at(-1)).toMatchObject({
      data: { roundId: parsed.data.roundId, positionRevision: 3 },
    });
    const value = JSON.stringify(f.observations.at(-1));
    expect(value).toContain(playerId);
    expect(value).not.toContain("private");
    f.sockets[0].receive({ type: "room.chat.snapshot", messages: [{ text: "private-chat" }] });
    expect(JSON.stringify(f.observations)).not.toContain("private-chat");
    expect(() => new f.w.WebSocket("invalid")).toThrow(f.failure);
    f.sockets[0].close();
    expect(f.observations.at(-1)).toMatchObject({ data: { connected: false, selfId: null } });
  } finally {
    await f.w.happyDOM.close();
  }
});
test("fetchのPromiseをそのまま返し、応答本文を消費せず、古い接続を無視する", async () => {
  const f = fixture();
  try {
    new f.w.WebSocket("wss://tetraboard.net/api/rooms/12345/ws");
    const returned = f.w.fetch("/api/rooms/12345") as unknown as Promise<Response>;
    expect(returned).toBe(f.promise);
    await settle();
    expect((await (await returned).json()).room.id).toBe("12345");
    new f.w.WebSocket("wss://tetraboard.net/api/rooms/12345/ws");
    f.sockets[1].open();
    f.sockets[1].receive(snapshot());
    f.sockets[1].receive({ type: "room.authenticated", membership: { playerId } });
    const count = f.observations.length;
    f.sockets[0].receive(snapshot());
    f.sockets[0].close();
    expect(f.observations).toHaveLength(count);
  } finally {
    await f.w.happyDOM.close();
  }
});

for (const source of ["GET", "WebSocket"] as const)
  for (const versioned of [false, true])
    test(`${source}で受け取った${versioned ? "新版" : "旧版"}の四人リバーシを解析できる`, async () => {
      const frame = snapshot();
      const { roundId, positionRevision, ...legacyRoom } = frame.room;
      const received = { ...frame, room: versioned ? frame.room : legacyRoom };
      const f = fixture(received);
      const starts: ContinuousRequest[] = [];
      const controller = new WidgetController(
        async (message) => {
          const command = message as { type: string; request: ContinuousRequest };
          if (command.type === "start") starts.push(command.request);
          if (command.type === "start" || command.type === "poll")
            return { ok: true, data: progressFor(starts.at(-1)!) };
          return { ok: true };
        },
        () => {},
        f.w.location.href,
        async () => "a".repeat(64),
        undefined,
        () => () => {},
      );
      try {
        new f.w.WebSocket("wss://tetraboard.net/api/rooms/12345/ws");
        const ws = f.sockets[0]!;
        ws.open();
        // 自分の手番でないGET局面は手動、WebSocket局面は本人手番の自動解析で確認します。
        const selfId = source === "GET" ? frame.room.players[1]!.id : playerId;
        ws.receive({ type: "room.authenticated", membership: { playerId: selfId } });
        if (source === "GET") await f.w.fetch("/api/rooms/12345");
        else ws.receive(received);
        await settle();
        const message = f.observations.at(-1) as { data?: unknown } | undefined;
        const observation = observationSchema.safeParse(message?.data);
        if (observation.success) controller.observe(observation.data);

        await controller.toggle();
        if (source === "GET") {
          expect(starts).toHaveLength(0);
          await controller.analyze();
        }
        await settle();
        expect(starts).toHaveLength(1);
        expect(starts[0]!.input).toMatchObject({
          game: "four-reversi",
          state: { board: frame.room.game.board, moveNumber: 0 },
        });
        expect(controller.observation).toMatchObject({
          roundId: versioned ? roundId : null,
          positionRevision: versioned ? positionRevision : null,
        });
      } finally {
        controller.stop();
        await f.w.happyDOM.close();
      }
    });

test("四人将棋の局ID・revision・合法手・担当方向を受信し氏名やtokenを除外する", async () => {
  const f = fixture();
  try {
    new f.w.WebSocket("wss://tetraboard.net/api/rooms/12345/ws");
    f.sockets[0].open();
    const o = shogiObservation(),
      original = snapshot();
    const room = fourShogiRoomSchema.parse({
      ...original.room,
      settings: {
        game: "four-shogi",
        mode: "singles",
        threePlayerAttackProhibited: true,
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
      },
      players: original.room.players.map((p, i) => {
        const { color: _color, ...rest } = p;
        return { ...rest, side: o.players[i].side };
      }),
      game: o.game,
      roundId: o.roundId,
      positionRevision: 0,
      legalActions: o.legalActions,
      checkState: { south: false, west: false, north: false, east: false },
      eliminations: [],
      clock: {
        remainingMainMs: { south: 300000, west: 300000, north: 300000, east: 300000 },
        turnStartedAt: 100,
        turnExpiresAt: 330100,
      },
    });
    f.sockets[0].receive({ ...original, room });
    f.sockets[0].receive({
      type: "room.authenticated",
      membership: { playerId, token: "private-token" },
    });
    expect(f.observations.at(-1)).toMatchObject({
      data: {
        gameId: "four-shogi",
        roundId: o.roundId,
        positionRevision: 0,
        legalActions: o.legalActions,
        players: o.players,
      },
    });
    expect(JSON.stringify(f.observations)).not.toContain("private");
  } finally {
    await f.w.happyDOM.close();
  }
});
