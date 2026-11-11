import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { channel, observationSchema, roomIdFromUrl, type Observation } from "./model";
let generation = 0;
let latest: Observation | null = null;
let socket: WebSocket | null = null;
let selfId: string | null = null;
let connected = false;
function emit() {
  if (latest && latest.roomId === roomIdFromUrl(location.href))
    window.postMessage(
      { channel, type: "observation", data: { ...latest, selfId, connected } },
      location.origin,
    );
}
function snapshot(body: unknown, id: string, expectedGeneration: number) {
  if (expectedGeneration !== generation || !body || typeof body !== "object" || !("room" in body))
    return;
  const parsed = fourReversiRoomSchema.safeParse(body.room);
  if (!parsed.success || parsed.data.id !== id) return;
  const room = parsed.data;
  const time =
    "serverNowMs" in body && typeof body.serverNowMs === "number" ? body.serverNowMs : -1;
  if (
    time < 0 ||
    (latest?.instanceId === room.instanceId &&
      latest.generation === generation &&
      time < latest.serverNowMs)
  )
    return;
  const presence = "presence" in body ? body.presence : null;
  const connectedPlayerIds =
    presence &&
    typeof presence === "object" &&
    "connectedPlayerIds" in presence &&
    Array.isArray(presence.connectedPlayerIds)
      ? presence.connectedPlayerIds
      : [];
  const value = observationSchema.safeParse({
    roomId: id,
    instanceId: room.instanceId,
    generation,
    connected,
    selfId,
    serverNowMs: time,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, color: p.color })),
    connectedPlayerIds,
    game: room.status === "playing" && room.game.mode === "singles" ? room.game : null,
    turnStartedAt: room.status === "playing" ? room.clock.turnStartedAt : null,
  });
  if (value.success) {
    latest = value.data;
    emit();
  }
}
const NativeWebSocket = window.WebSocket;
window.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args, newTarget) {
    const ws = Reflect.construct(target, args, newTarget) as WebSocket;
    try {
      const url = new URL(String(args[0]), location.href);
      const id = url.pathname.match(/^\/api\/rooms\/(\d{5})\/ws$/)?.[1];
      if (
        id &&
        url.host === location.host &&
        url.protocol === (location.protocol === "https:" ? "wss:" : "ws:")
      ) {
        const current = ++generation;
        socket = ws;
        selfId = null;
        connected = false;
        emit();
        latest = null;
        ws.addEventListener("open", () => {
          if (socket === ws) {
            connected = true;
            emit();
          }
        });
        ws.addEventListener("message", (event) => {
          if (socket !== ws || typeof event.data !== "string") return;
          try {
            const value = JSON.parse(event.data);
            if (value.type === "room.snapshot") snapshot(value, id, current);
            if (
              value.type === "room.authenticated" &&
              typeof value.membership?.playerId === "string"
            ) {
              selfId = value.membership.playerId;
              emit();
            }
            if (
              value.type === "room.error" &&
              ["unauthorized", "room_changed", "not_found"].includes(value.error)
            ) {
              selfId = null;
              emit();
            }
          } catch {
            /* 不正な受信データで対局処理を妨げません。 */
          }
        });
        const closed = () => {
          if (socket === ws) {
            connected = false;
            selfId = null;
            emit();
          }
        };
        ws.addEventListener("close", closed);
        ws.addEventListener("error", closed);
      }
    } catch {
      /* 監視の失敗を既存のWebSocketへ伝播させません。 */
    }
    return ws;
  },
});
const nativeFetch = window.fetch;
window.fetch = new Proxy(nativeFetch, {
  apply(target, thisArg, args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const result = Reflect.apply(target, thisArg, args) as ReturnType<typeof fetch>;
    try {
      const input = args[0];
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.href,
      );
      const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
      const id = url.pathname.match(/^\/api\/rooms\/(\d{5})$/)?.[1];
      const current = generation;
      if (id && url.origin === location.origin && method.toUpperCase() === "GET")
        void result
          .then((response) => {
            if (response.ok)
              return response
                .clone()
                .json()
                .then((body) => snapshot(body, id, current));
          })
          .catch(() => {});
    } catch {
      /* 監視対象外の要求も元のPromiseをそのまま返します。 */
    }
    return result;
  },
});
window.addEventListener("message", (event) => {
  if (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.channel === channel &&
    event.data.type === "request"
  )
    emit();
});
