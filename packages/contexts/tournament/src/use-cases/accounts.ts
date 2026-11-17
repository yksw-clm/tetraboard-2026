import type { TournamentQueueRuntime } from "./ports";
import type { State } from "../domain/queue";
import { tokenKey } from "../domain/queue";
import { forget } from "./waiting";
import { rollback } from "./rollback";
import { tick } from "./tick";
export async function purgeAccount(r: TournamentQueueRuntime, state: State, accountId: string) {
  for (const w of state.waiting.filter((w) => w.accountId === accountId)) await forget(r, w);
  state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
  r.storage.save(state);
  for (const g of [...state.groups])
    if (g.players.some((p) => p.accountId === accountId)) {
      if (g.phase !== "playing") await rollback(r, state, g, [accountId]);
      if (g.phase === "playing") g.players = g.players.filter((p) => p.accountId !== accountId);
    }
  r.storage.save(state);
  await tick(r, state);
}

export async function cancelForAccount(r: TournamentQueueRuntime, state: State, accountId: string) {
  for (const w of state.waiting.filter((w) => w.accountId === accountId)) await forget(r, w);
  state.waiting = state.waiting.filter((w) => w.accountId !== accountId);
  r.storage.save(state);
  for (const g of [...state.groups])
    if (g.phase !== "playing" && g.players.some((p) => p.accountId === accountId)) {
      const player = g.players.find((p) => p.accountId === accountId)!;
      r.storage.cancel(tokenKey(accountId, player.operationId));
      await rollback(r, state, g, [accountId]);
    }
  await tick(r, state);
}
