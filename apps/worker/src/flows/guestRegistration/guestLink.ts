import {
  cancelGuestRoomLink as cancelRoomLink,
  completeGuestLink as completeLink,
  mergeGuestAccounts as merge,
  prepareGuestLink as prepareLink,
  prepareGuestLinkClaim,
  promoteGuestLink as promote,
  readGuestMerge as readMerge,
  rememberGuestLink as rememberLink,
  requireGuestIdle as requireIdle,
  type GuestLinkChecks,
  type GuestMergeFlow,
  type RegistrationFlow,
  type StoredProfile,
} from "@tetraboard/context-account";
import { accountSessionIdentity, type AuthEnv } from "../../accounts/auth";
import { D1GuestLinks } from "../../adapters/account/guestLinks";
import { D1GuestLinkWrites, type GuestLinkWrite } from "../../adapters/account/guestLinkWrites";
import { D1Registrations } from "../../adapters/account/registrations";
import { guestFeedbackTransferStatement } from "../../adapters/community/guestMergeWrites";
import { guestPrivacyTransferStatements } from "../../adapters/privacy/guestMergeWrites";
import {
  guestBadgeTransferStatements,
  guestMatchAccountTransferStatements,
  guestReplayTransferStatements,
} from "../../adapters/record/guestMergeWrites";
import { guestSeatTransferStatement } from "../../adapters/room/guestMergeWrites";
import { guestTournamentTransferStatements } from "../../adapters/tournament/guestMergeWrites";
import { guestChatMergeStatements } from "../../lobby/mergeGuestChat";
import { mergeNotificationStatements } from "../../notifications/store";
import {
  clearGuestSession,
  guestIdentity,
  guestTokenHash,
  suspendGuestSession,
} from "../../routes/guestSession";

function guestLinkChecks(env: Env, store: D1GuestLinks): GuestLinkChecks {
  const registrations = new D1Registrations(env.APP_DB);
  return {
    guestBusy: (id) => store.guestBusy(id),
    readRegistration: (id) => registrations.read(id),
    roomRegistration: (roomId, id) => env.GAME_ROOM.getByName(roomId).getGuestRegistration(id),
    now: () => Date.now(),
  };
}

export function prepareGuestLink(request: Request, env: Env, registration?: RegistrationFlow) {
  return prepareLink(
    guestLinkChecks(env, new D1GuestLinks(env.APP_DB)),
    {
      hasAccountCookie: () =>
        /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
          request.headers.get("Cookie") ?? "",
        ),
      guestIdentity: () => guestIdentity(request, env),
    },
    registration,
  );
}

export function rememberGuestLink(
  request: Request,
  env: Env,
  guest: StoredProfile,
  state: string,
  provider: string,
  roomRegistrationId?: string,
) {
  return rememberLink(
    new D1GuestLinks(env.APP_DB),
    { now: () => Date.now(), tokenHash: () => guestTokenHash(request) },
    guest.id,
    state,
    provider,
    roomRegistrationId,
  );
}

export async function completeGuestLinkCallback(
  request: Request,
  env: AuthEnv,
  accountRequest: () => Request,
) {
  const url = new URL(request.url);
  const store = new D1GuestLinks(env.APP_DB);
  const suspend = () => suspendGuestSession(request, env);
  const pending = await prepareGuestLinkClaim(
    store,
    {
      tokenHash: () => guestTokenHash(request),
      identity: () => accountSessionIdentity(accountRequest(), env),
      suspendGuestSession: suspend,
      acceptProvider: (provider) => url.pathname.endsWith("/callback/" + provider),
      now: () => Date.now(),
      id: () => crypto.randomUUID(),
    },
    url.searchParams.get("state"),
  );
  if (!pending) return;
  const { flow, claim, roomClaim } = pending;
  const claimed = await store.commitClaim(claim, roomClaim);
  return completeLink(flow, Boolean(claimed), {
    deleteAccountSession: (accountId, sessionId) =>
      store.deleteAccountSession(accountId, sessionId),
    suspendGuestSession: suspend,
    promote: (link) => promoteGuestLink(request, env, link),
    clearGuestSession: () => clearGuestSession(request, env),
    promotionWillBeRetried: () => console.error("Guest promotion will be retried"),
  });
}

export function requireGuestIdle(env: Env, id: string) {
  return requireIdle(new D1GuestLinks(env.APP_DB), id);
}

export async function mergeGuestAccounts(env: Env, flow: GuestMergeFlow) {
  const db = env.APP_DB;
  const store = new D1GuestLinks(db);
  const { guest_id: guestId, target_id: targetId } = flow;
  const account = await merge<GuestLinkWrite>(
    {
      ...guestLinkChecks(env, store),
      roomsForAccount: (id) => store.roomsForAccount(id),
      roomMergeConflict: (roomId, guestId, targetId) =>
        env.GAME_ROOM.getByName(roomId).guestMergeConflict(guestId, targetId),
    },
    new D1GuestLinkWrites(db),
    flow,
  );
  await db.batch(
    [
      ...account.initialWrites,
      ...(account.held ? [guestSeatTransferStatement(db, guestId, targetId, account.held)] : []),
      guestFeedbackTransferStatement(db, guestId, targetId),
      ...guestReplayTransferStatements(db, guestId, targetId),
      ...guestChatMergeStatements(db, guestId, targetId),
      ...mergeNotificationStatements(db, guestId, targetId),
      ...guestMatchAccountTransferStatements(db, guestId, targetId),
      ...guestTournamentTransferStatements(db, guestId, targetId),
      ...guestPrivacyTransferStatements(db, guestId, targetId),
      ...guestBadgeTransferStatements(db, guestId, targetId),
      ...account.prepareFinalWrites(),
    ].flat(),
  );
}

export async function promoteGuestLink(request: Request, env: AuthEnv, flow: GuestMergeFlow) {
  const store = new D1GuestLinks(env.APP_DB);
  const statements = await promote<GuestLinkWrite>(
    {
      ...guestLinkChecks(env, store),
      tokenHash: () => guestTokenHash(request),
      targetEmail: (id) => store.targetEmail(id),
      nowIso: () => new Date().toISOString(),
    },
    new D1GuestLinkWrites(env.APP_DB),
    flow,
  );
  await env.APP_DB.batch(statements.flat());
}

export function readGuestMerge(request: Request, env: AuthEnv) {
  return readMerge(new D1GuestLinks(env.APP_DB), {
    identity: () => accountSessionIdentity(request, env),
    tokenHash: () => guestTokenHash(request),
    now: () => Date.now(),
  });
}

export function cancelGuestRoomLink(env: Env, id: string) {
  const store = new D1GuestLinks(env.APP_DB);
  return cancelRoomLink(
    {
      cancelRegistration: (registrationId, now) => store.cancelRegistration(registrationId, now),
      cancelRoomRegistration: (roomId, registrationId) =>
        env.GAME_ROOM.getByName(roomId).cancelGuestRegistration(registrationId),
      now: () => Date.now(),
    },
    id,
  );
}
