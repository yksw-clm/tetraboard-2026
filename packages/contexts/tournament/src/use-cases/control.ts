import type { TournamentQueueRuntime } from "./ports";
import type { State, Player, Group, ControllerClaim } from "../domain/queue";
import { ok, fail, holder, canClaim } from "../domain/queue";
import { participation } from "./status";
import { tick } from "./tick";
export async function confirm(
  r: TournamentQueueRuntime,
  state: State,
  accountId: string,
  operationId: string,
  matchId: string,
) {
  await tick(r, state);
  const group = state.groups.find((g) => g.id === matchId),
    player = group?.players.find((p) => p.accountId === accountId && p.operationId === operationId);
  // 旧画面の承諾・拒否は新方式の成立済み予約を変更しません。
  return group && player ? ok : fail("参加確認の受付は終了しました。");
}
export async function claimController(
  r: TournamentQueueRuntime,
  state: State,
  accountId: string,
  input: ControllerClaim,
) {
  const currentHolder = holder(state, accountId, input.operationId);
  const current = await participation(r, state, accountId, input.controllerId);
  if (
    !currentHolder ||
    current.operationId !== input.operationId ||
    !(await r.eligible(accountId, state.key))
  )
    return fail("参加中の待機や対局がありません。");
  if (!canClaim(currentHolder, input))
    return fail("操作元が更新されました。状態を再確認してください。");
  if (currentHolder.controllerId !== input.controllerId) {
    currentHolder.controllerId = input.controllerId;
    currentHolder.controllerVersion = (currentHolder.controllerVersion ?? 0) + 1;
  }
  const credential = await r.credential({
    accountId,
    tournamentKey: state.key,
    operationId: currentHolder.operationId,
    controllerId: input.controllerId,
    controllerVersion: currentHolder.controllerVersion ?? 0,
  });
  if (currentHolder.tokenHash !== credential.tokenHash || currentHolder.credentialPending) {
    currentHolder.tokenHash = credential.tokenHash;
    currentHolder.credentialDerived = true;
    currentHolder.credentialPending = true;
    r.storage.save(state);
    const group = state.groups.find((group) => group.players.includes(currentHolder as Player));
    if (group) await syncCredential(r, state, group, currentHolder as Player);
    else {
      currentHolder.credentialPending = false;
      r.storage.save(state);
    }
  }
  const result = await participation(r, state, accountId, input.controllerId);
  return result.operationId === input.operationId &&
    result.controller === "self" &&
    !holder(state, accountId, input.operationId)?.credentialPending
    ? { ok: true as const, participation: result, token: credential.token }
    : fail("参加中の待機や対局がありません。");
}
export async function syncCredential(
  r: TournamentQueueRuntime,
  state: State,
  group: Group,
  player: Player,
) {
  if (!player.credentialPending) return;
  const result = await r.room(group.roomId).rekeyTournamentPlayer({
    matchId: group.id,
    instanceId: group.instanceId,
    accountId: player.accountId,
    operationId: player.admission.operationId,
    playerId: player.admission.playerId,
    version: player.controllerVersion ?? 0,
    tokenHash: player.tokenHash,
  });
  if (result.status === "stale") throw new Error("Tournament credential version mismatch");
  if (result.status === "not_found") return;
  player.credentialPending = false;
  r.storage.save(state);
}
