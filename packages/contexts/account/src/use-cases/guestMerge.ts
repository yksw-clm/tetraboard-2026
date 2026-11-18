import {
  assertGuestMergeRoom,
  guestPromotionCredentials,
  type GuestMergeFlow,
} from "../domain/guestLink";
import { heldRoomRegistration, requireGuestIdle, type GuestLinkChecks } from "./guestLinkChecks";

export interface RoomLinkWrites<Write> {
  commitRoomLink(registrationId: string, flow: GuestMergeFlow, now: number): Write;
  releaseRoomLink(registrationId: string): Write;
}

export interface GuestMergeWrites<Write> extends RoomLinkWrites<Write> {
  recordMerge(guestId: string, targetId: string, now: number): Write;
  retireGuest(guestId: string): Write[];
  acceptRoomRecord(registrationId: string, targetId: string, now: number): Write;
}

export interface GuestMergeChecks extends GuestLinkChecks {
  roomsForAccount(id: string): Promise<string[]>;
  roomMergeConflict(roomId: string, guestId: string, targetId: string): Promise<boolean>;
}

function roomLinkCommitStatements<Write>(
  writes: RoomLinkWrites<Write>,
  flow: GuestMergeFlow,
  now: () => number,
) {
  return flow.room_registration_id
    ? [writes.commitRoomLink(flow.room_registration_id, flow, now())]
    : [];
}

export async function mergeGuestAccounts<Write>(
  checks: GuestMergeChecks,
  writes: GuestMergeWrites<Write>,
  flow: GuestMergeFlow,
) {
  const { guest_id: guestId, target_id: targetId, room_registration_id: registrationId } = flow;
  const rooms = await checks.roomsForAccount(guestId);
  for (const room of rooms)
    assertGuestMergeRoom(await checks.roomMergeConflict(room, guestId, targetId));

  const held = await heldRoomRegistration(checks, registrationId, guestId);
  if (registrationId && !held) await requireGuestIdle(checks, guestId);
  return {
    held,
    initialWrites: [
      ...roomLinkCommitStatements(writes, flow, () => checks.now()),
      writes.recordMerge(guestId, targetId, checks.now()),
    ],
    prepareFinalWrites: () => [
      ...writes.retireGuest(guestId),
      ...(registrationId
        ? [
            writes.acceptRoomRecord(registrationId, targetId, checks.now()),
            writes.releaseRoomLink(registrationId),
          ]
        : []),
    ],
  };
}

export interface GuestPromotionWrites<Write> extends RoomLinkWrites<Write> {
  recordPromotion(flow: GuestMergeFlow, hash: string, now: number): Write;
  releaseTemporaryEmail(targetId: string): Write;
  promoteGuest(
    flow: GuestMergeFlow,
    email: string,
    hash: string,
    clock: Pick<GuestPromotionChecks, "now" | "nowIso">,
  ): Write;
  transferProviderAndSessions(guestId: string, targetId: string): Write[];
  transferRegistration(registrationId: string, flow: GuestMergeFlow): Write;
  deleteTemporaryUser(targetId: string): Write;
  retirePromotedGuestCredentials(guestId: string): Write[];
}

export interface GuestPromotionChecks extends GuestLinkChecks {
  tokenHash(): Promise<string | null>;
  targetEmail(id: string): Promise<{ email: string } | null>;
  nowIso(): string;
}

export async function promoteGuestLink<Write>(
  checks: GuestPromotionChecks,
  writes: GuestPromotionWrites<Write>,
  flow: GuestMergeFlow,
) {
  const { guest_id: guestId, target_id: targetId, room_registration_id: registrationId } = flow;
  const held = await heldRoomRegistration(checks, registrationId, guestId);
  if (!held) await requireGuestIdle(checks, guestId);
  await requireGuestIdle(checks, targetId);
  const tokenHash = await checks.tokenHash();
  const target = await checks.targetEmail(targetId);
  const { hash, email } = guestPromotionCredentials(tokenHash, target);
  return [
    ...roomLinkCommitStatements(writes, flow, () => checks.now()),
    writes.recordPromotion(flow, hash, checks.now()),
    writes.releaseTemporaryEmail(targetId),
    writes.promoteGuest(flow, email, hash, checks),
    ...writes.transferProviderAndSessions(guestId, targetId),
    ...(registrationId ? [writes.transferRegistration(registrationId, flow)] : []),
    writes.deleteTemporaryUser(targetId),
    ...writes.retirePromotedGuestCredentials(guestId),
    ...(registrationId ? [writes.releaseRoomLink(registrationId)] : []),
  ];
}
