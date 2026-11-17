import type { TournamentQueueRuntime, TournamentCoordinatorWrite } from "./ports";
import { connectionDeadline } from "../domain/queue";
import type { State, Group } from "../domain/queue";
import type { TournamentRow } from "../domain/types";
import { rollback } from "./rollback";
import { syncCredential } from "./control";
import { validWait } from "./waiting";
export async function transfer(
  r: TournamentQueueRuntime,
  state: State,
  group: Group,
  row: TournamentRow,
) {
  group.phase = "preparing";
  r.storage.save(state);
  const statements: TournamentCoordinatorWrite[] = [];
  const profiles = await r.store.waitingProfiles(state.key);
  for (const player of group.players) {
    const profile = profiles.get(player.operationId);
    if (!profile || !validWait(r, player)) {
      await rollback(r, state, group, [player.accountId]);
      return;
    }
    player.admission.name = profile.name;
    Object.assign(player.admission, r.avatar(profile));
    statements.push(...r.store.preparePlayer(player, profile, state.key));
  }
  r.storage.save(state);
  await r.store.commit(statements);
  const prepared = await prepareRoom(r, group, row);
  if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
    await rollback(r, state, group, []);
    return;
  }
  for (const player of group.players)
    if (player.credentialPending) await syncCredential(r, state, group, player);
  group.phase = "matched";
  group.expiresAtMs = connectionDeadline(r.now(), r.rules.connectionGraceMs, row.ends_at_ms!);
  // Retain the queue fence until preparation is known to have succeeded. The account seat now owns exclusion.
  await r.store.releaseWaiting(group.players);
  r.storage.save(state);
}
export async function prepareRoom(r: TournamentQueueRuntime, group: Group, row: TournamentRow) {
  const matchSequence = group.assignSequence
    ? await r.reserveMatchSequence(group.id, `tournament:${row.key}`)
    : undefined;
  return r.room(group.roomId).prepareTournamentRoom({
    context: {
      tournamentId: row.public_id!,
      ...(matchSequence === undefined ? {} : { matchSequence }),
      tournamentKey: row.key,
      matchId: group.id,
      startsAtMs: row.starts_at_ms!,
      endsAtMs: row.ends_at_ms!,
      ruleVersion: row.rule_version,
      ...(row.rule_version === 2 ? { settings: r.settings(row) } : {}),
    },
    roomId: group.roomId,
    instanceId: group.instanceId,
    players: group.players.map((p) => ({
      admission: p.admission,
      tokenHash: p.tokenHash,
      credentialVersion: p.credentialDerived ? (p.controllerVersion ?? 0) : 0,
    })),
  });
}
