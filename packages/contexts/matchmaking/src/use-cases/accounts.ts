import type { MatchmakingRuntime } from "./ports";
import { type State } from "../domain/state";

import { tick } from "./tick";
import { locate } from "../domain/waits";
import { forget, rollback } from "./rollback";
export async function leaveAccount(r: MatchmakingRuntime, state: State, accountId: string) {
  await tick(r, state);
  const { wait, group } = locate(state, accountId);
  if (!wait) return;
  if (group?.phase === "playing") return;
  if (group) await rollback(r, state, group, [accountId], 0, "cancelled");
  else {
    await forget(r, wait, state, "cancelled");
    state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
  }
}

export async function purgeAccount(r: MatchmakingRuntime, state: State, accountId: string) {
  const { wait, group } = locate(state, accountId);
  if (wait && group && group.phase !== "playing") await rollback(r, state, group, [accountId]);
  for (const waiting of state.waiting.filter((w) => w.accountId === accountId))
    await forget(r, waiting, state);
  state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
  for (const group of state.groups)
    group.players = group.players.filter((p) => p.accountId !== accountId);
  state.groups = state.groups.filter((g) => g.players.length > 0);
  r.storage.save(state);
}

export async function cleanupReleasedGroups(r: MatchmakingRuntime, state: State) {
  const players = state.groups
    .filter((g) => g.phase === "playing")
    .flatMap((g) => g.players.filter((p) => !p.released));
  for (let offset = 0; offset < players.length; offset += 100) {
    const batch = players.slice(offset, offset + 100);
    const occupied = new Set(
      await r.store.occupiedOperations(batch.map((p) => p.admission.operationId)),
    );
    for (const p of batch)
      if (!occupied.has(p.admission.operationId)) {
        p.released = true;
        p.credentialPending = false;
        r.storage.end(p.operationId);
      }
  }
  state.groups = state.groups.filter(
    (g) => g.phase !== "playing" || g.players.some((p) => !p.released),
  );
}
