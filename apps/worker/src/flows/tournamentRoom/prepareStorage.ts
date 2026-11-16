import type { Room } from "@tetraboard/protocol";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { appendSystem } from "../../durableObjects/gameRoom/chat";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  accountKey,
  disconnectedAtKey,
  membershipStorageKey,
  playerTokenKey,
  viewerSecretKey,
} from "../../durableObjects/gameRoom/storageKeys";
import { bytesToHex } from "../../durableObjects/gameRoom/tokenCrypto";
import { roomStorageKey } from "../../rooms/progressHelpers";
import { currentRoomStateVersion, roomStateVersionKey } from "../../rooms/roomStateVersion";
import {
  tournamentCredentialVersionKey,
  tournamentReservationKey,
  tournamentReturnKey,
  tournamentRoomKey,
  type PrepareTournamentRoomInput,
  type TournamentRoomReservation,
} from "../../rooms/tournamentRoom";
import { analyticsPlayerKey } from "../../usageEvents/matches";

export function persistTournamentRoom(
  runtime: RoomRuntime,
  input: PrepareTournamentRoomInput,
  checks: D1Result[],
  room: Room,
  reservation: TournamentRoomReservation,
  now: number,
) {
  const { context, players } = input;
  withIndexTransaction(runtime, () => {
    runtime.ctx.storage.kv.put(roomStorageKey, room);
    runtime.ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
    runtime.ctx.storage.kv.put(tournamentRoomKey, context.matchId);
    runtime.ctx.storage.kv.delete(tournamentReturnKey);
    runtime.ctx.storage.kv.put(tournamentReservationKey(context.matchId), reservation);
    for (const [index, { admission, tokenHash, credentialVersion }] of players.entries()) {
      runtime.ctx.storage.kv.put(accountKey(admission.playerId), {
        ...admission,
        occupying: true,
      });
      runtime.ctx.storage.kv.put(membershipStorageKey(tokenHash), {
        playerId: admission.playerId,
        role: index === 0 ? "host" : "player",
      });
      runtime.ctx.storage.kv.put(playerTokenKey(admission.playerId), tokenHash);
      runtime.ctx.storage.kv.put(
        tournamentCredentialVersionKey(admission.playerId),
        credentialVersion ?? 0,
      );
      runtime.ctx.storage.kv.put(disconnectedAtKey(admission.playerId), now);
      const profile = checks[index].results[0] as { isTestUser?: unknown };
      runtime.ctx.storage.kv.put(analyticsPlayerKey(admission.playerId), {
        accountId: admission.accountId,
        visitorId: null,
        isTest: Boolean(profile.isTestUser),
      });
      appendSystem(runtime, "joined", `${admission.name}が入室しました`);
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    runtime.ctx.storage.kv.put(viewerSecretKey, bytesToHex(secret));
  });
}
