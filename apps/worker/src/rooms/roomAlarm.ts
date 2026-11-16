import { matchmakingRules, tournamentRules, type Room } from "@tetraboard/protocol";
import { earliestAlarmAt } from "./roomDeadlines";

type Retry = { retryAtMs: number };
export type RoomAlarmInput = {
  room: Room | null;
  registrations: ReadonlyMap<string, { holdUntilMs: number }>;
  usesIdleDeadline: boolean;
  cpuAlarmAt: number | null;
  capacity: { releaseAtMs: number | null } | undefined;
  index: Retry | undefined;
  accountCleanups: Iterable<Retry>;
  matches: Iterable<Retry>;
  shogiMatches: Iterable<Retry>;
  guestClaims: Retry | undefined;
  tournamentStates: Iterable<Retry>;
  tournament: {
    status: "waiting" | "playing" | "closed";
    preparedAtMs: number;
    context: { endsAtMs: number };
  } | null;
  matchmaking:
    | {
        phase: "waiting" | "playing" | "closed";
        expiresAtMs: number;
        aiWarmup?: { state: "pending"; nextAtMs: number } | { state: "ready" | "failed" };
      }
    | undefined;
};

export function nextRoomAlarmAt(input: RoomAlarmInput): number | null {
  const { room, registrations, tournament } = input;
  const deadlines =
    room?.players
      .filter((player) => player.kind === "human" && !registrations.has(player.id))
      .map((player) => player.reconnectDeadline)
      .filter((value) => value !== null) ?? [];
  if (room && input.usesIdleDeadline) deadlines.push(room.lastActivityAtMs + 24 * 60 * 60 * 1000);
  for (const player of room?.players ?? []) {
    const registration = registrations.get(player.id);
    if (registration) deadlines.push(registration.holdUntilMs);
  }
  if (room?.status === "playing") {
    deadlines.push(room.clock.turnExpiresAt);
    if (input.cpuAlarmAt !== null) deadlines.push(input.cpuAlarmAt);
  }
  if (input.capacity?.releaseAtMs != null) deadlines.push(input.capacity.releaseAtMs);
  if (input.index) deadlines.push(input.index.retryAtMs);
  for (const jobs of [
    input.accountCleanups,
    input.matches,
    input.shogiMatches,
    input.tournamentStates,
  ])
    for (const job of jobs) deadlines.push(job.retryAtMs);
  if (input.guestClaims) deadlines.push(input.guestClaims.retryAtMs);
  if (tournament?.status === "waiting")
    deadlines.push(
      Math.min(
        tournament.preparedAtMs + tournamentRules.connectionGraceMs,
        tournament.context.endsAtMs,
      ),
    );
  if (room?.status === "waiting" && "tournamentStartsAtMs" in room && room.tournamentStartsAtMs)
    deadlines.push(room.tournamentStartsAtMs);
  deadlines.push(...matchmakingDeadlines(room, input.matchmaking));
  return earliestAlarmAt(deadlines);
}

function matchmakingDeadlines(room: Room | null, saved: RoomAlarmInput["matchmaking"]): number[] {
  if (
    !room ||
    !("matchmaking" in room) ||
    !room.matchmaking ||
    room.status !== "waiting" ||
    room.lastRound
  )
    return [];
  const deadlines = [room.matchmaking.preparedAtMs + matchmakingRules.connectionGraceMs];
  if (room.matchmaking.startsAtMs !== undefined) deadlines.push(room.matchmaking.startsAtMs);
  if (saved?.phase === "waiting" && saved.aiWarmup?.state === "pending")
    deadlines.push(
      Math.min(saved.aiWarmup.nextAtMs, saved.expiresAtMs - matchmakingRules.countdownMs),
    );
  return deadlines;
}
