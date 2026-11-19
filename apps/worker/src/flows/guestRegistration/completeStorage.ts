import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { roomSchema, type Room, type RoomMembership } from "@tetraboard/protocol";
import type { AccountAdmission } from "../accountSeats/types";
import { profileAvatarUrl } from "../../adapters/account/auth";
import {
  accountKey,
  membershipStorageKey,
  playerTokenKey,
  disconnectedAtKey,
  reconnectGraceMs,
} from "../../durableObjects/gameRoom/storageKeys";
import { roomStorageKey, nextPublicUpdateAt } from "../../rooms/progressHelpers";
import { analyticsPlayerKey, type AnalyticsIdentity } from "../../usageEvents/matches";
import {
  activeRegistrationKey,
  registrationKey,
  type StoredGuestRegistration,
} from "../../adapters/account/registrationTypes";

export function persistRegistrationCredentials(
  runtime: RoomRuntime,
  registrationId: string,
  admission: AccountAdmission,
  analytics: AnalyticsIdentity | undefined,
  record: StoredGuestRegistration,
  membership: RoomMembership,
  now: number,
) {
  const updatedRecord: StoredGuestRegistration = {
    ...record,
    state: "converted",
    accountId: admission.accountId,
    admission,
  };
  runtime.ctx.storage.kv.put(accountKey(record.playerId), { ...admission, occupying: true });
  runtime.ctx.storage.kv.delete(membershipStorageKey(record.oldTokenHash));
  runtime.ctx.storage.kv.put(membershipStorageKey(record.newTokenHash), membership);
  runtime.ctx.storage.kv.put(playerTokenKey(record.playerId), record.newTokenHash);
  runtime.ctx.storage.kv.put(disconnectedAtKey(record.playerId), now);
  runtime.ctx.storage.kv.put(registrationKey(registrationId), updatedRecord);
  runtime.ctx.storage.kv.delete(activeRegistrationKey(record.playerId));
  const previousIdentity = runtime.ctx.storage.kv.get<AnalyticsIdentity>(
    analyticsPlayerKey(record.playerId),
  );
  runtime.ctx.storage.kv.put(analyticsPlayerKey(record.playerId), {
    visitorId: analytics?.visitorId ?? previousIdentity?.visitorId ?? null,
    accountId: admission.accountId,
    isTest: analytics?.isTest ?? false,
  } satisfies AnalyticsIdentity);
  return updatedRecord;
}

export function updateRegistrationAppearance(
  runtime: RoomRuntime,
  admission: AccountAdmission,
  record: StoredGuestRegistration,
  room: Room,
  last: Room["lastRound"],
  now: number,
) {
  const avatarUrl = profileAvatarUrl(admission.avatarKey, admission.avatarPresetId);
  runtime.ctx.storage.kv.put(
    roomStorageKey,
    roomSchema.parse({
      ...room,
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: now,
      players: room.players.map((p) => {
        if (p.id !== record.playerId || p.kind !== "human") return p;
        const { registrationPendingUntilMs: _pending, isGuest: _guest, ...player } = p;
        return {
          ...player,
          name: admission.name,
          avatarUrl,
          ready: false,
          reconnectDeadline: now + reconnectGraceMs,
        };
      }),
      lastRound: last && {
        ...last,
        players: last.players.map((p) =>
          p.id === record.playerId
            ? { ...p, name: admission.name, appearance: { kind: "human", avatarUrl } }
            : p,
        ),
      },
    }),
  );
}
