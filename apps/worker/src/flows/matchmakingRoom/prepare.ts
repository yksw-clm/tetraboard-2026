import { cpuProfileRating, hasProfileRating } from "@tetraboard/context-rating";
import { roomSchema, type ProfileRatings, type Room } from "@tetraboard/protocol";
import { profileAvatarUrl } from "../../adapters/account/auth";
import { readProfileRating } from "../../adapters/rating/profileRatings";
import { reserveCpuCapacity } from "../../adapters/room/cpuCapacity";
import { readRoom } from "../../adapters/room/state";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cancelledAdmissionKey, cpuCapacityKey } from "../../durableObjects/gameRoom/storageKeys";
import type {
  QueueRatingSource,
  MatchmakingRoomInput,
  MatchmakingRoomReservation,
} from "@tetraboard/context-matchmaking";
import {
  matchmakingCpuAppearance,
  matchmakingRoomConfiguration,
  matchmakingRoomMetadata,
} from "../../rooms/gameAdapters/matchmaking";
import { waitingRoomFactories } from "../../adapters/room/waitingRoomFactories";
import { persistMatchmakingRoom } from "./prepareStorage";

type MatchmakingConfiguration = ReturnType<typeof matchmakingRoomConfiguration>;

export async function prepareMatchmakingRoom(runtime: RoomRuntime, input: MatchmakingRoomInput) {
  await runtime.reconcileDeadlines();
  return runtime.ctx.blockConcurrencyWhile(async () => {
    return prepareReservedMatchmakingRoom(runtime, input);
  });
}

async function prepareReservedMatchmakingRoom(runtime: RoomRuntime, input: MatchmakingRoomInput) {
  const rating = input.rating;
  const configuration = matchmakingRoomConfiguration(input);
  const { rules, policy } = configuration;
  if (
    (input.matchSequence !== undefined &&
      (!Number.isSafeInteger(input.matchSequence) || input.matchSequence < 1 || !rating)) ||
    input.roomId !== runtime.ctx.id.name ||
    input.players.length < 1 ||
    input.players.length > rules.seats ||
    (rating ? !policy?.validParticipants(rating, input.players.length) : policy !== undefined) ||
    new Set(input.players.map((p) => p.admission.accountId)).size !== input.players.length ||
    Date.now() >= input.expiresAtMs ||
    input.expiresAtMs !== input.preparedAtMs + rules.connectionGraceMs
  )
    return { status: "invalid" as const };
  const existing = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(
    `matchmaking:${input.matchId}`,
  );
  if (existing)
    return existing.phase === "closed"
      ? { status: "cancelled" as const }
      : { status: "prepared" as const };
  if (runtime.ctx.storage.kv.get(`matchmaking-cancelled:${input.matchId}`))
    return { status: "cancelled" as const };
  if (readRoom(runtime)) return { status: "room_in_use" as const };
  return prepareEligibleMatchmakingRoom(runtime, input, configuration);
}

async function prepareEligibleMatchmakingRoom(
  runtime: RoomRuntime,
  input: MatchmakingRoomInput,
  configuration: MatchmakingConfiguration,
) {
  if (!(await checkMatchmakingAdmissions(runtime, input, configuration)))
    return { status: "invalid" as const };
  const { room, cpuCount } = createWaitingMatchmakingRoom(runtime, input, configuration);
  const profileRatings = await readMatchmakingProfileRatings(runtime, input, room, configuration);
  const capacity = await reserveCpuCapacity(runtime, room);
  if (typeof capacity === "string") return { status: capacity };
  if (Date.now() >= input.expiresAtMs) {
    if (capacity) {
      runtime.ctx.storage.kv.put(cpuCapacityKey, { ...capacity, releaseAtMs: Date.now() });
      runtime.ctx.waitUntil(runtime.jobs.cpuCapacityJob.flush());
    }
    return { status: "invalid" as const };
  }
  persistMatchmakingRoom(runtime, input, room, cpuCount, profileRatings, capacity);
  return { status: "prepared" as const };
}

async function checkMatchmakingAdmissions(
  runtime: RoomRuntime,
  input: MatchmakingRoomInput,
  configuration: MatchmakingConfiguration,
) {
  const { rules, policy } = configuration;
  for (const { admission: a } of input.players) {
    await runtime.alarms.sync();
    const valid = await runtime.db
      .prepare(
        `SELECT 1 FROM account_room_seats s JOIN user u ON u.id=s.account_id JOIN matchmaking_wait_reservations w ON w.account_id=s.account_id WHERE s.account_id=? AND s.operation_id=? AND s.room_id=? AND s.instance_id=? AND s.player_id=? AND w.match_operation_id=s.operation_id AND w.queue_key=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id)
            ${
              policy
                ? `AND COALESCE(u.isAnonymous,0)=0 AND EXISTS (
              SELECT 1 FROM ${policy.store.pendingTable} p WHERE p.game='${policy.store.game}' AND p.account_id=s.account_id AND p.match_id=?
            )`
                : ""
            }`,
      )
      .bind(
        a.accountId,
        a.operationId,
        input.roomId,
        input.instanceId,
        a.playerId,
        rules.key,
        ...(policy ? [input.matchId] : []),
      )
      .first();
    if (!valid || runtime.ctx.storage.kv.get(cancelledAdmissionKey(a.operationId))) return false;
  }
  return true;
}

function createWaitingMatchmakingRoom(
  runtime: RoomRuntime,
  input: MatchmakingRoomInput,
  configuration: MatchmakingConfiguration,
) {
  const rating = input.rating;
  const { game, legacy, rules } = configuration;
  const entry = { code: input.roomId, name: input.players[0]!.admission.name };
  const base = waitingRoomFactories[game]({
    ...entry,
    request: { game, mode: "singles", quickPlay: false, timeControl: rules.timeControl },
  });
  const { profile, cpuName } = matchmakingCpuAppearance(game, rating, legacy);
  const seat = runtime.gameAdapter(base).waitingSeat;
  const cpuCount = rules.seats - input.players.length;
  const room = roomSchema.parse({
    ...base,
    instanceId: input.instanceId,
    matchmaking: matchmakingRoomMetadata(input),
    players: [
      ...input.players.map(({ admission: a }) => ({
        id: a.playerId,
        name: a.name,
        kind: "human",
        avatarUrl: profileAvatarUrl(a.avatarKey, a.avatarPresetId),
        ...(a.isGuest ? { isGuest: true } : {}),
        ready: true,
        ...seat,
        reconnectDeadline: input.expiresAtMs,
      })),
      ...Array.from({ length: cpuCount }, (_, i) => ({
        id: crypto.randomUUID(),
        name: profile
          ? `${profile.name}${i + 1}`
          : cpuCount > 1 && cpuName
            ? `${cpuName}${i + 1}`
            : (cpuName ?? "CPU"),
        kind: "cpu",
        level: 2,
        ...(profile ? { cpuProfile: profile } : {}),
        ready: true,
        ...seat,
        reconnectDeadline: null,
      })),
    ],
  });
  return { room, cpuCount };
}

async function readMatchmakingProfileRatings(
  runtime: RoomRuntime,
  input: MatchmakingRoomInput,
  room: Room,
  configuration: MatchmakingConfiguration,
) {
  const rating = input.rating;
  const { game } = configuration;
  const profileRatings: ProfileRatings = {};
  if (rating && hasProfileRating(game)) {
    for (const { admission } of input.players) {
      profileRatings[admission.playerId] = await readProfileRating(
        runtime.db,
        admission.accountId,
        game,
        "before",
      );
    }
    const reference = cpuReferenceRating(rating);
    if (reference)
      for (const player of room.players)
        if (player.kind === "cpu") profileRatings[player.id] = reference;
  }
  return profileRatings;
}

function cpuReferenceRating(source: QueueRatingSource) {
  switch (source.kind) {
    case "cpu":
      return cpuProfileRating({ rating: source.referenceRating });
    case "reversi":
      return source.source.kind === "cpu"
        ? cpuProfileRating({ rating: source.source.referenceRating })
        : undefined;
    case "four-shogi":
    case "four-reversi":
      return source.cpu ? cpuProfileRating({ mu: source.cpu.mu }) : undefined;
  }
}
