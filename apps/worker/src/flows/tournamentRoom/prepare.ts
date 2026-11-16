import { persistTournamentRoom } from "./prepareStorage";
import { roomSchema, tournamentRules, getTournamentSettings } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cancelledAdmissionKey } from "../../durableObjects/gameRoom/storageKeys";
import { profileAvatarUrl } from "../../accounts/auth";
import { waitingRoomFactories } from "../../rooms/waitingRoomFactories";
import { readTournament, tournamentSettingsMatch } from "../../tournaments/store";
import {
  tournamentReservationKey,
  cancelledTournamentKey,
  prepareTournamentRoomSchema,
  type PrepareTournamentRoomInput,
  type TournamentRoomReservation,
} from "../../rooms/tournamentRoom";

export async function prepareTournamentRoom(
  runtime: RoomRuntime,
  input: PrepareTournamentRoomInput,
) {
  const parsed = prepareTournamentRoomSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid_reservation" as const };
  await runtime.reconcileDeadlines();
  const { context, roomId, instanceId, players } = parsed.data;
  if (
    roomId !== runtime.ctx.id.name ||
    context.startsAtMs >= context.endsAtMs ||
    new Set(players.map((p) => p.admission.accountId)).size !== 4 ||
    new Set(players.map((p) => p.admission.playerId)).size !== 4 ||
    new Set(players.map((p) => p.tokenHash)).size !== 4 ||
    players.some((p) => p.admission.roomId !== roomId || p.admission.instanceId !== instanceId)
  )
    return { status: "invalid_reservation" as const };
  return runtime.ctx.blockConcurrencyWhile(() =>
    prepareReservedTournamentRoom(runtime, parsed.data),
  );
}

async function prepareReservedTournamentRoom(
  runtime: RoomRuntime,
  input: PrepareTournamentRoomInput,
) {
  const { context, roomId, instanceId, players } = input;
  const existing = runtime.ctx.storage.kv.get<TournamentRoomReservation>(
    tournamentReservationKey(context.matchId),
  );
  if (
    existing &&
    (existing.roomId !== roomId ||
      existing.instanceId !== instanceId ||
      JSON.stringify(existing.context) !== JSON.stringify(context))
  )
    return { status: "invalid_reservation" as const };
  if (existing)
    return {
      status: existing.status === "closed" ? ("cancelled" as const) : ("already_prepared" as const),
    };
  if (runtime.ctx.storage.kv.get(cancelledTournamentKey(context.matchId)))
    return { status: "cancelled" as const };
  if (runtime.readRoom()) return { status: "room_in_use" as const };
  await runtime.syncAlarm();
  const checks = await checkTournamentAdmissions(runtime, input);
  if (
    checks.some((check) => check.results.length !== 1) ||
    Date.now() < context.startsAtMs ||
    Date.now() >= context.endsAtMs ||
    players.some(
      (p) =>
        runtime.ctx.storage.kv.get(cancelledAdmissionKey(p.admission.operationId)) ||
        runtime.readMembership(p.tokenHash),
    )
  )
    return { status: "invalid_reservation" as const };
  const definition = await readTournament(runtime.db, context.tournamentKey);
  if (!definition || !tournamentSettingsMatch(definition, context))
    return { status: "invalid_reservation" as const };
  return createTournamentRoom(runtime, input, checks);
}

async function checkTournamentAdmissions(runtime: RoomRuntime, input: PrepareTournamentRoomInput) {
  const { context, roomId, instanceId, players } = input;
  return runtime.db.batch(
    players.map(({ admission }) =>
      runtime.db
        .prepare(`SELECT u.isTestUser FROM account_room_seats s
          JOIN user u ON u.id=s.account_id
          JOIN tournament_match_players p ON p.match_id=? AND p.account_id=s.account_id AND p.player_id=s.player_id AND p.operation_id=s.operation_id
          JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=s.account_id AND e.deleted=0
          JOIN tournament_matches m ON m.id=p.match_id AND m.tournament_key=e.tournament_key
          JOIN tournaments t ON t.key=m.tournament_key
          WHERE s.account_id=? AND s.operation_id=? AND s.room_id=? AND s.instance_id=? AND s.player_id=?
            AND s.name=? AND s.avatar_key IS ? AND s.avatar_preset_id IS ? AND u.profileCompleted=1
            AND m.phase='reserved' AND m.room_id=? AND m.instance_id=?
            AND t.key=? AND t.public_id=? AND t.published=1 AND t.rule_version=?
            AND t.starts_at_ms=? AND t.ends_at_ms=?
            AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`)
        .bind(
          context.matchId,
          admission.accountId,
          admission.operationId,
          roomId,
          instanceId,
          admission.playerId,
          admission.name,
          admission.avatarKey,
          admission.avatarPresetId ?? null,
          roomId,
          instanceId,
          context.tournamentKey,
          context.tournamentId,
          context.ruleVersion,
          context.startsAtMs,
          context.endsAtMs,
        ),
    ),
  );
}

function createTournamentRoom(
  runtime: RoomRuntime,
  input: PrepareTournamentRoomInput,
  checks: D1Result[],
) {
  const { context, roomId, instanceId, players } = input;
  const settings = getTournamentSettings(context);
  const now = Date.now();
  const base = waitingRoomFactories[settings.game]({
    code: roomId,
    name: players[0].admission.name,
    request: { ...settings, quickPlay: false },
  });
  const room = roomSchema.parse({
    ...base,
    instanceId,
    tournamentId: context.tournamentId,
    players: players.map(({ admission }) => ({
      id: admission.playerId,
      kind: "human",
      name: admission.name,
      avatarUrl: profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
      ...(admission.isGuest ? { isGuest: true } : {}),
      ready: true,
      ...runtime.gameAdapter(base).waitingSeat,
      reconnectDeadline: Math.min(now + tournamentRules.connectionGraceMs, context.endsAtMs),
    })),
  });
  const reservation: TournamentRoomReservation = {
    context,
    roomId,
    instanceId,
    status: "waiting",
    preparedAtMs: now,
  };
  persistTournamentRoom(runtime, input, checks, room, reservation, now);
  return { status: "prepared" as const };
}
