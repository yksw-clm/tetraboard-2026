import type { TournamentAdmission } from "./room";

export type Waiting = {
  accountId: string;
  operationId: string;
  tokenHash: string;
  expiresAtMs: number;
  controllerId?: string;
  controllerVersion?: number;
  credentialDerived?: boolean;
  credentialPending?: boolean;
};
export type Player = Waiting & {
  entryId: string;
  admission: TournamentAdmission;
  waitingExpiresAtMs?: number;
};
export type Group = {
  assignSequence?: true;
  id: string;
  roomId: string;
  instanceId: string;
  expiresAtMs: number;
  phase: "confirming" | "preparing" | "matched" | "playing" | "cancelling";
  players: Player[];
  remove?: string[];
  rollbackAfterPublication?: boolean;
  waitingReleasePending?: true;
};
export type State = { key: string; waiting: Waiting[]; groups: Group[] };
export type Result = { ok: true } | { ok: false; status: 400 | 403 | 409; message: string };
export const ok: Result = { ok: true };
export const fail = (message: string, status: 400 | 403 | 409 = 409): Result => ({
  ok: false,
  status,
  message,
});
export const tokenKey = (_account: string, operation: string) => `cancel:${operation}`;
export const controllerCancelKey = (operation: string, controllerId: string, version: number) =>
  `cancel-controller:${operation}:${controllerId}:${version}`;
export const locallyValid = (wait: Waiting, now: number, cancelled: boolean) =>
  wait.expiresAtMs > now && !cancelled;
export const connectionDeadline = (now: number, graceMs: number, endsAtMs: number) =>
  Math.min(now + graceMs, endsAtMs);
export function controller(wait: Waiting, controllerId?: string) {
  return {
    controller:
      controllerId !== undefined && wait.controllerId === controllerId
        ? ("self" as const)
        : ("other" as const),
    controllerVersion: wait.controllerVersion ?? 0,
  };
}
export function holder(state: State, accountId: string, operationId: string) {
  return (
    state.waiting.find((p) => p.accountId === accountId && p.operationId === operationId) ??
    state.groups
      .flatMap((g) => g.players)
      .find((p) => p.accountId === accountId && p.operationId === operationId)
  );
}
export function selectFour(waiting: Waiting[], random: (bound: number) => number) {
  const pool = [...waiting];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, 4);
}
export type ControllerClaim = {
  operationId: string;
  controllerId: string;
  takeover: boolean;
  expectedControllerVersion: number;
};
export function canClaim(wait: Waiting, input: ControllerClaim) {
  const version = wait.controllerVersion ?? 0;
  if (!input.takeover && input.expectedControllerVersion !== version) return false;
  if (
    input.takeover &&
    wait.controllerId === input.controllerId &&
    input.expectedControllerVersion !== version &&
    input.expectedControllerVersion !== version - 1
  )
    return false;
  return (
    wait.controllerId === input.controllerId ||
    (input.takeover && input.expectedControllerVersion === version)
  );
}
