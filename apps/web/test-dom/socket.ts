import { beforeEach, afterEach } from "bun:test";
import { act } from "./harness";
import { now, playerIds } from "../test/fixtures/rooms";
import type { Room } from "@tetraboard/protocol";

export class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  failSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    Socket.instances.push(this);
  }
  open() {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(JSON.parse(data));
  }
  receive(body: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(body) }));
  }
  snapshot(room: Room, serverNowMs = now) {
    this.receive({
      type: "room.snapshot",
      room,
      presence: { hostPlayerId: playerIds[0], connectedPlayerIds: room.players.map((p) => p.id) },
      serverNowMs,
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}
const original = globalThis.WebSocket;
beforeEach(() => {
  Socket.instances = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = original;
});
