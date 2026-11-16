import * as room from "@tetraboard/context-room";
import type { RoomTimeControl } from "@tetraboard/protocol";
import type { RoomRuntime, SocketCommand } from "../../durableObjects/gameRoom/runtime";
import { withIndexTransaction } from "./transaction";
import { invokeRoomUseCase } from "./useCases";

export function setReady(runtime: RoomRuntime, hash: string, ready: boolean) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.setReady(op, hash, ready)),
  );
}
export function applySettings(
  runtime: RoomRuntime,
  hash: string,
  command: SocketCommand<"room.settings.apply">,
) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.applySettings(op, hash, command)),
  );
}
export function setTimeControl(runtime: RoomRuntime, hash: string, control: RoomTimeControl) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.setTimeControl(op, hash, control)),
  );
}
export function updateGameSettings(
  runtime: RoomRuntime,
  hash: string,
  command: room.SettingsCommand,
) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.updateGameSettings(op, hash, command)),
  );
}
export function play(runtime: RoomRuntime, hash: string, command: room.ActionCommand) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.play(op, hash, command)),
  );
}
export function setShogiDrawProposal(
  runtime: RoomRuntime,
  hash: string,
  command: room.DrawCommand,
) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.setShogiDrawProposal(op, hash, command)),
  );
}
export function declareShogi(runtime: RoomRuntime, hash: string, command: room.DeclareCommand) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.declareShogi(op, hash, command)),
  );
}
export function resign(runtime: RoomRuntime, hash: string) {
  return withIndexTransaction(runtime, () =>
    invokeRoomUseCase(runtime, (op) => room.resign(op, hash)),
  );
}

export function applyProgress<G extends import("@tetraboard/protocol").GameId>(
  runtime: RoomRuntime,
  result: room.ProgressFor<G>,
) {
  return invokeRoomUseCase(runtime, (op) => room.applyProgress(op, result));
}
export function removeWaitingPlayer(
  runtime: RoomRuntime,
  waiting: Extract<import("@tetraboard/protocol").Room, { status: "waiting" }>,
  playerId: string,
) {
  return invokeRoomUseCase(runtime, (op) => room.removeWaitingPlayer(op, waiting, playerId));
}
export function closeIfNoHumanParticipants<T extends import("@tetraboard/protocol").Room>(
  runtime: RoomRuntime,
  current: T | null,
): T | null {
  return invokeRoomUseCase(runtime, (op) => room.closeIfNoHumanParticipants(op, current));
}
