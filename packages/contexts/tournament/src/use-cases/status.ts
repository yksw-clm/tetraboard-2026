import type { TournamentQueueRuntime } from "./ports";
import type { State } from "../domain/queue";
import { controller } from "../domain/queue";
import type { TournamentParticipation } from "@tetraboard/protocol";
import { validWait } from "./waiting";
import { tick } from "./tick";
export async function participation(
  r: TournamentQueueRuntime,
  state: State,
  accountId: string,
  controllerId?: string,
): Promise<TournamentParticipation> {
  const profile = await r.store.participation(state.key, accountId);
  const entered = !!profile;
  if (!profile) return { entered: false, status: "idle", controller: "none", controllerVersion: 0 };
  const wait = state.waiting.find((w) => w.accountId === accountId);
  if (
    wait &&
    validWait(r, wait) &&
    profile.waitingOperation === wait.operationId &&
    (profile.leaseUntilMs ?? 0) > r.now() &&
    profile.endsAtMs > r.now()
  )
    return {
      entered,
      ...controller(wait, controllerId),
      status: "waiting",
      operationId: wait.operationId,
      expiresAtMs: wait.expiresAtMs,
    };
  for (const g of state.groups) {
    const p = g.players.find((p) => p.accountId === accountId);
    if (!p) continue;
    if (g.phase === "confirming" || g.phase === "preparing")
      return {
        entered,
        ...controller(p, controllerId),
        status: "waiting",
        operationId: p.operationId,
        expiresAtMs: g.expiresAtMs,
      };
    if (g.phase === "cancelling") continue;
    if (profile.seatOperation === p.admission.operationId)
      return {
        entered,
        ...controller(p, controllerId),
        status: g.phase === "playing" ? "playing" : "matched",
        operationId: p.operationId,
        matchId: g.id,
        roomId: g.roomId,
        instanceId: g.instanceId,
      };
  }
  return { entered, status: "idle", controller: "none", controllerVersion: 0 };
}
export async function entryStatuses(r: TournamentQueueRuntime, state: State) {
  await tick(r, state);
  const statuses: Record<string, "waiting" | "matched" | "playing"> = {};
  for (const w of state.waiting) statuses[w.accountId] = "waiting";
  for (const g of state.groups)
    for (const p of g.players) {
      const current = await participation(r, state, p.accountId);
      if (current.status !== "idle") statuses[p.accountId] = current.status;
    }
  return statuses;
}
