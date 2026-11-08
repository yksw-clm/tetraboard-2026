import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInitialState } from "@tetraboard/four-reversi";
import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { playerId, settle } from "./fixtures";
const script = await Bun.file(new URL("../dist/bridge.js", import.meta.url)).text();
function fixture() {
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
  const promise = Promise.resolve(Response.json(snapshot()));
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
