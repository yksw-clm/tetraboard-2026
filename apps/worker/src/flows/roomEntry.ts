import type { CreateRoomRequest, JoinRoomRequest, Room, RoomError } from "@tetraboard/protocol";
import { defaultGameId } from "@tetraboard/protocol/games";
import { profileAvatarUrl, type StoredProfile } from "../adapters/account/auth";
import type { GameRoom } from "../durableObjects/gameRoom/gameRoom";
import { waitingRoomFactories } from "../adapters/room/waitingRoomFactories";
import { browserIdFromRequest } from "../usageEvents/browserId";
import { roomEntryProfile, RoomAccountError } from "./accountSeats/entryProfile";
import { reserveAccountSeat, cancelReservation } from "./accountSeats/reserve";
import type { AccountAdmission } from "./accountSeats/types";

export type JoinRoomResult = Awaited<ReturnType<GameRoom["joinRoom"]>>;

type RoomEntryResponse<Args extends unknown[]> = {
  success: (...args: Args) => Response;
  failure: (
    error: RoomError["error"],
    status: RoomAccountError["status"] | 404 | 410 | 500,
  ) => Response;
};

const roomCodeCount = 100_000;
const maxRoomCodeAttempts = 20;
const randomLimit = Math.floor(2 ** 32 / roomCodeCount) * roomCodeCount;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function createMembershipToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

function generateRoomCode(): string {
  const values = new Uint32Array(1);

  do {
    crypto.getRandomValues(values);
  } while (values[0] >= randomLimit);

  return String(values[0] % roomCodeCount).padStart(5, "0");
}

export async function createRoomWithAvailableCode(
  env: Env,
  rawRequest: Request,
  request: CreateRoomRequest,
  respond: RoomEntryResponse<[code: string, room: Room, token: string]>,
) {
  let profile;
  try {
    profile = await roomEntryProfile(rawRequest, env, request.name);
  } catch (error) {
    return respond.failure(
      error instanceof RoomAccountError ? error.code : "internal_error",
      error instanceof RoomAccountError ? error.status : 503,
    );
  }
  const token = createMembershipToken();
  const tokenHash = await hashMembershipToken(token);

  return tryRoomCodes(env, rawRequest, request, profile, token, tokenHash, respond);
}

async function tryRoomCodes(
  env: Env,
  rawRequest: Request,
  request: CreateRoomRequest,
  profile: Awaited<ReturnType<typeof roomEntryProfile>>,
  token: string,
  tokenHash: string,
  respond: RoomEntryResponse<[code: string, room: Room, token: string]>,
) {
  for (let attempt = 0; attempt < maxRoomCodeAttempts; attempt++) {
    const code = generateRoomCode();
    const game = request.game ?? defaultGameId;
    const initialRoom = waitingRoomFactories[game]({
      code,
      name: profile.name,
      request,
    });

    let admission: AccountAdmission | undefined;
    try {
      if (profile.user) {
        admission = await reserveAccountSeat(
          rawRequest,
          env,
          profile.user,
          initialRoom,
          initialRoom.players[0].id,
        );
        applyHostAdmission(initialRoom, admission);
      }
      const room = await env.GAME_ROOM.getByName(code).createRoom(
        initialRoom,
        tokenHash,
        admission,
        roomEntryAnalytics(rawRequest, profile.user),
      );
      if (room === null) {
        if (admission) await cancelReservation(env, admission);
        continue;
      }

      return respond.success(code, room, token);
    } catch (error) {
      // A failed response may follow a committed admission. Only the DO can decide.
      if (admission) await cancelFailedRoomEntryReservation(env, admission);
      return respond.failure(
        error instanceof RoomAccountError ? error.code : "internal_error",
        error instanceof RoomAccountError ? error.status : 500,
      );
    }
  }

  return respond.failure("code_unavailable", 503);
}

function applyHostAdmission(initialRoom: Room, admission: AccountAdmission) {
  initialRoom.players[0].name = admission.name;
  if (initialRoom.players[0].kind === "human") {
    initialRoom.players[0].avatarUrl = profileAvatarUrl(
      admission.avatarKey,
      admission.avatarPresetId,
    );
    if (admission.isGuest) initialRoom.players[0].isGuest = true;
  }
}

export async function joinRequestedRoom(
  env: Env,
  rawRequest: Request,
  code: string,
  request: JoinRoomRequest,
  respond: RoomEntryResponse<[result: JoinRoomResult, token: string]>,
) {
  let admission: AccountAdmission | undefined;
  try {
    const profile = await roomEntryProfile(rawRequest, env, request.name);
    if (profile.user) {
      const current = await env.GAME_ROOM.getByName(code).getRoom();
      if (!current) return respond.failure("not_found", 404);
      if (request.instanceId && request.instanceId !== current.instanceId)
        return respond.failure("room_changed", 410);
      if ("tournamentId" in current && current.tournamentId !== undefined)
        return respond.failure("tournament_required", 409);
      admission = await reserveAccountSeat(
        rawRequest,
        env,
        profile.user,
        current,
        crypto.randomUUID(),
      );
    }
    const token = createMembershipToken();
    const tokenHash = await hashMembershipToken(token);
    const result = await env.GAME_ROOM.getByName(code).joinRoom(
      admission?.name ?? profile.name,
      tokenHash,
      request.instanceId,
      admission,
      roomEntryAnalytics(rawRequest, profile.user),
    );
    if (result.status !== "joined" && admission) await cancelReservation(env, admission);
    return respond.success(result, token);
  } catch (error) {
    if (admission) await cancelFailedRoomEntryReservation(env, admission);
    return respond.failure(
      error instanceof RoomAccountError ? error.code : "internal_error",
      error instanceof RoomAccountError ? error.status : 500,
    );
  }
}

function roomEntryAnalytics(request: Request, user: StoredProfile | null) {
  return {
    visitorId: browserIdFromRequest(request),
    accountId: user?.id ?? null,
    isGuest: Boolean(user?.isAnonymous),
    isTest: Boolean(user?.isTestUser),
  };
}

async function cancelFailedRoomEntryReservation(env: Env, admission: AccountAdmission) {
  try {
    await cancelReservation(env, admission);
  } catch {
    /* recovered later */
  }
}
