import { redirect } from "react-router";
import { claimTournamentController, readTournamentParticipation } from "./tournamentApi";
import { tournamentDocumentController } from "./tournamentController";
import {
  readTournamentRoom,
  readTournamentQueue,
  saveTournamentQueue,
  saveTournamentRoom,
} from "./tournamentQueueStorage";
import { saveRoomMembershipToken } from "../../shared/roomMembership";

export async function recoverTournamentRoom(
  roomId: string,
  instanceId: string | undefined,
  signal: AbortSignal,
  controller = tournamentDocumentController,
) {
  const reference = readTournamentRoom(roomId, instanceId);
  if (!reference) return;
  const controllerId = controller.getIdentity();
  const revision = controller.getRevision();
  const scope = `${reference.tournamentId}:${reference.identity}`;
  const returnToTournament = (reason: string) =>
    redirect(`/tournaments/${reference.tournamentId}?return=${reason}`);
  const checkCurrent = () => {
    signal.throwIfAborted();
    if (controller.getIdentity() !== controllerId || controller.getRevision() !== revision)
      throw returnToTournament("transferred");
  };
  let acquired = false;
  let committed = false;
  try {
    checkCurrent();
    const participation = await readTournamentParticipation(
      reference.tournamentId,
      signal,
      controllerId,
    );
    checkCurrent();
    if (
      participation.operationId !== reference.operationId ||
      participation.roomId !== roomId ||
      participation.instanceId !== reference.instanceId ||
      !["matched", "playing"].includes(participation.status)
    )
      throw returnToTournament("unavailable");
    const ownedVersion = controller.version(scope, participation.operationId);
    const self =
      participation.controller === "self" && ownedVersion === participation.controllerVersion;
    if (!self) {
      const saved = readTournamentQueue(reference.tournamentId, reference.identity);
      const lastOwnedVersion =
        saved?.operationId === reference.operationId
          ? (saved.controllerVersion ?? reference.controllerVersion)
          : reference.controllerVersion;
      if (!controller.isReload() || lastOwnedVersion !== participation.controllerVersion)
        throw returnToTournament("transferred");
      acquired = await controller.acquire(scope);
      checkCurrent();
      if (!acquired) throw returnToTournament("transferred");
    }
    const result = await claimTournamentController(reference.tournamentId, {
      operationId: reference.operationId,
      controllerId,
      takeover: !self,
      expectedControllerVersion: self ? ownedVersion : participation.controllerVersion,
    });
    checkCurrent();
    if (
      result.participation.controller !== "self" ||
      result.participation.operationId !== reference.operationId ||
      result.participation.roomId !== roomId ||
      result.participation.instanceId !== reference.instanceId
    )
      throw returnToTournament("unavailable");
    saveTournamentQueue(reference.tournamentId, reference.identity, {
      operationId: reference.operationId,
      token: result.token,
      controllerVersion: result.participation.controllerVersion,
    });
    if (
      !saveRoomMembershipToken(roomId, result.token) ||
      !saveTournamentRoom({
        ...reference,
        controllerVersion: result.participation.controllerVersion,
      })
    )
      throw new Response("大会の参加資格を保存できませんでした。", { status: 503 });
    controller.remember(scope, reference.operationId, result.participation.controllerVersion);
    committed = true;
  } finally {
    if (
      acquired &&
      !committed &&
      controller.getIdentity() === controllerId &&
      controller.getRevision() === revision
    )
      controller.release(scope);
  }
}
