import {
  membershipTokenSchema,
  roomSocketContract,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import { isTournamentGameRoom } from "../../../rooms/tournamentRoom";
import { hashMembershipToken } from "../tokenCrypto";
import { stampTag } from "../storageKeys";
import { rejectAction, sendSocketError } from "../snapshots";
import type { RoomRuntime } from "../runtime";
import { dispatchMessage } from "./dispatch";

function parseMessage(
  runtime: RoomRuntime,
  socket: WebSocket,
  message: string | ArrayBuffer,
): RoomSocketClientMessage | null {
  if (typeof message !== "string" || message.length > 8192) {
    sendSocketError(runtime, socket, "invalid_request");
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    sendSocketError(runtime, socket, "invalid_request");
    return null;
  }
  const parsed = roomSocketContract.clientMessage.safeParse(body);
  if (parsed.success) return parsed.data;
  // スタンプの拒否は、並行する準備や着手の応答と区別します。
  const stampError =
    typeof body === "object" &&
    body !== null &&
    "type" in body &&
    body.type === "room.stamp.send" &&
    "requestId" in body
      ? roomSocketContract.message.safeParse({
          type: "room.stamp.error",
          requestId: body.requestId,
          error: "invalid_request",
        })
      : null;
  if (stampError?.success && runtime.ctx.getTags(socket).includes(stampTag))
    socket.send(JSON.stringify(stampError.data));
  else sendSocketError(runtime, socket, "invalid_request");
  return null;
}

function socketTokenHash(socket: WebSocket): string | null {
  const attachment: unknown = socket.deserializeAttachment();
  const parsed =
    typeof attachment === "object" && attachment !== null && "tokenHash" in attachment
      ? membershipTokenSchema.safeParse(attachment.tokenHash)
      : null;
  return parsed?.success ? parsed.data : null;
}

function canDispatch(
  runtime: RoomRuntime,
  socket: WebSocket,
  command: RoomSocketClientMessage,
  tokenHash: string | null,
): boolean {
  if (command.type === "room.auth" || command.type === "room.stamp.send") return true;
  if (tokenHash === null) {
    sendSocketError(runtime, socket, "unauthorized");
    return false;
  }
  const tournamentRoom = runtime.readRoom();
  if (
    tournamentRoom &&
    ((isTournamentGameRoom(tournamentRoom) && tournamentRoom.tournamentId !== undefined) ||
      ("matchmaking" in tournamentRoom && tournamentRoom.matchmaking)) &&
    ([
      "room.ready.set",
      "room.settings.apply",
      "room.three-player-attack.set",
      "room.time-control.set",
      "room.mode.set",
      "room.cpu.add",
      "room.cpu.remove",
      "room.cpu.level.set",
      "room.game.start",
    ].includes(command.type) ||
      (command.type === "room.game.draw.set" &&
        !runtime.gameAdapter(tournamentRoom).allowsCompetitiveDraw))
  ) {
    rejectAction(runtime, socket, "forbidden");
    return false;
  }
  return true;
}

export async function webSocketMessage(
  runtime: RoomRuntime,
  socket: WebSocket,
  message: string | ArrayBuffer,
): Promise<void> {
  const command = parseMessage(runtime, socket, message);
  if (command === null) return;
  try {
    // hash計算中に復帰期限を越える場合も、照合直前に期限を処理します。
    const authTokenHash =
      command.type === "room.auth" ? await hashMembershipToken(command.token) : null;
    await runtime.reconcileDeadlines();
    if (runtime.readRoom() === null) {
      sendSocketError(runtime, socket, "not_found");
      return;
    }
    const tokenHash = command.type === "room.auth" ? authTokenHash : socketTokenHash(socket);
    if (canDispatch(runtime, socket, command, tokenHash))
      await dispatchMessage(runtime, socket, command, tokenHash);
  } catch {
    if (command.type === "room.stamp.send" && runtime.ctx.getTags(socket).includes(stampTag)) {
      socket.send(
        JSON.stringify({
          type: "room.stamp.error",
          requestId: command.requestId,
          error: "internal_error",
        }),
      );
    } else sendSocketError(runtime, socket, "internal_error");
  }
}
