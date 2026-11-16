import { roomSocketContract } from "@tetraboard/protocol";
import { readRoom } from "../../adapters/room/state";
import { formationAnalysisTag } from "../../rooms/fourShogiFormationAnalysis";
import { eliminatedHandsTag } from "../../rooms/fourShogiProgress";
import { chatSnapshot } from "./chat";
import type { RoomRuntime } from "./runtime";
import { sendRoomSnapshot } from "./snapshots";
import { stampTag } from "./storageKeys";

export async function fetch(runtime: RoomRuntime, request: Request): Promise<Response> {
  const query = roomSocketContract.query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (room === null) {
    return Response.json(roomSocketContract.error.parse({ error: "not_found" }), { status: 404 });
  }
  if (query.data.instanceId !== undefined && room.instanceId !== query.data.instanceId) {
    return Response.json({ error: "room_changed" }, { status: 410 });
  }

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(roomSocketContract.error.parse({ error: "upgrade_required" }), {
      status: 426,
    });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  runtime.ctx.acceptWebSocket(server, [
    ...(query.data.formationAnalysis === "1" ? [formationAnalysisTag] : []),
    ...(query.data.eliminatedHands === "1" ? [eliminatedHandsTag] : []),
    ...(query.data.stamps === "1" ? [stampTag] : []),
  ]);
  sendRoomSnapshot(runtime, server, room);
  server.send(JSON.stringify(chatSnapshot(runtime)));

  return new Response(null, { status: 101, webSocket: client });
}
