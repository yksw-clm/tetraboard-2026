import type { TournamentQueueRuntime } from "./ports";
import type { State, Waiting, Player, Group } from "../domain/queue";
import { selectFour, connectionDeadline } from "../domain/queue";
import type { TournamentRow } from "../domain/types";
import { stage } from "../domain/stage";
import { validWait } from "./waiting";
import { transfer } from "./transfer";
export async function formGroup(r: TournamentQueueRuntime, state: State, row: TournamentRow) {
  if (state.waiting.length < 4 || stage(row, r.now()) !== "active") return;
  const selected = selectFour(state.waiting, r.random),
    id = r.randomId(),
    instanceId = r.randomId();
  let roomId = r.randomRoomId();
  for (let i = 0; i < 20; i++) {
    const used = await r.store.roomUsed(roomId);
    if (!used) break;
    roomId = r.randomRoomId();
    if (i === 19) return;
  }
  const players = await groupPlayers(r, state, selected, row, roomId, instanceId);
  if (!players) return;
  const group: Group = {
    assignSequence: true,
    id,
    roomId,
    instanceId,
    expiresAtMs: connectionDeadline(r.now(), r.rules.connectionGraceMs, row.ends_at_ms!),
    phase: "preparing",
    players,
  };
  state.waiting = state.waiting.filter((w) => !selected.some((s) => s.accountId === w.accountId));
  state.groups.push(group);
  r.storage.save(state);
  await r.store.ensureGroup(state, group);
  await transfer(r, state, group, row);
}
export async function groupPlayers(
  r: TournamentQueueRuntime,
  state: State,
  selected: Waiting[],
  row: TournamentRow,
  roomId: string,
  instanceId: string,
) {
  const players: Player[] = [];
  const profiles = await r.store.waitingProfiles(state.key);
  for (const wait of selected) {
    const profile = profiles.get(wait.operationId);
    if (!profile || !validWait(r, wait)) return null;
    players.push({
      ...wait,
      waitingExpiresAtMs: wait.expiresAtMs,
      expiresAtMs: connectionDeadline(r.now(), r.rules.connectionGraceMs, row.ends_at_ms!),
      entryId: profile.entryId,
      admission: {
        accountId: wait.accountId,
        operationId: r.randomId(),
        roomId,
        instanceId,
        playerId: r.randomId(),
        name: profile.name,
        ...(profile.isAnonymous ? { isGuest: true } : {}),
        ...r.avatar(profile),
      },
    });
  }
  return players;
}
