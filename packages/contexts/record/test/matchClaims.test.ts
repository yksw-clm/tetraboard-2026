import { expect, test } from "bun:test";
import {
  checkMatchClaim,
  readClaimState,
  prepareMatchClaimTransitions,
  MatchClaimError,
  type MatchClaimReadStore,
  type ClaimRow,
  type MatchClaimInput,
  type MatchRow,
} from "../src";
import { matches, stored, decode } from "./readFixtures";

class MemoryClaimStore implements MatchClaimReadStore {
  deleted = false;
  saved: MatchRow | null = null;
  rows: ClaimRow[] = [];
  calls: string[] = [];
  async isDeleted(_accountId: string) {
    this.calls.push("deleted");
    return this.deleted;
  }
  async readState(matchId: string, playerId: string) {
    this.calls.push("state");
    return this.rows.find((r) => r.match_id === matchId && r.player_id === playerId) ?? null;
  }
  async readSaved(_matchId: string) {
    this.calls.push("saved");
    return this.saved;
  }
  async readPending(_matchId: string) {
    this.calls.push("pending");
    return this.rows.filter((r) => r.state === "pending");
  }
}
function fixture() {
  const match = structuredClone(stored(matches[0]).match);
  const player = match.record.participants[0];
  if (player.kind !== "human") throw Error("Expected human");
  player.accountId = null;
  const input: MatchClaimInput = {
    matchId: match.record.id,
    playerId: player.id,
    accountId: "target",
    roomId: match.record.roomId,
    instanceId: match.record.instanceId,
  };
  const store = new MemoryClaimStore();
  store.saved = { game: match.game, record_json: JSON.stringify(match.record) };
  const row: ClaimRow = {
    match_id: input.matchId,
    player_id: input.playerId,
    account_id: input.accountId,
    room_id: input.roomId,
    instance_id: input.instanceId,
    state: "pending",
  };
  return { store, input, match, row };
}
async function code(action: Promise<unknown>) {
  try {
    await action;
    return null;
  } catch (error) {
    if (!(error instanceof MatchClaimError)) throw error;
    return error.code;
  }
}
test("引き継ぎは退会・以前の状態・公開済み本体の順に照合し、保存待ちも受け付ける", async () => {
  const { store, input } = fixture();
  await checkMatchClaim(store, input, decode);
  expect(store.calls).toEqual(["deleted", "state", "saved"]);
  store.saved = null;
  await checkMatchClaim(store, input, decode);
});
test("退会と以前の拒否は本体を読む前に拒否し、別人のpendingは状態として返さない", async () => {
  const { store, input, row } = fixture();
  store.deleted = true;
  expect(await code(checkMatchClaim(store, input, decode))).toBe("retired");
  expect(store.calls).toEqual(["deleted"]);
  store.deleted = false;
  store.rows = [row];
  expect(await readClaimState(store, input.matchId, input.playerId, "other")).toBeNull();
  for (const state of ["retired", "rejected"] as const) {
    row.state = state;
    store.calls = [];
    expect(await code(checkMatchClaim(store, input, decode))).toBe(
      state === "retired" ? "retired" : "conflict",
    );
    expect(store.calls).toEqual(["deleted", "state"]);
  }
});
test("対局・部屋・世代・参加者の不一致を引き継がない", async () => {
  for (const field of ["matchId", "roomId", "instanceId", "playerId"] as const) {
    const { store, input } = fixture();
    expect(await code(checkMatchClaim(store, { ...input, [field]: "other" }, decode))).toBe(
      "ineligible",
    );
  }
});
test("CPU・帰属済み・退会した参加者を引き継がず、同じ本人の重複を拒否する", async () => {
  for (const change of ["cpu", "assigned", "retired", "duplicate"]) {
    const { store, input, match } = fixture();
    const player = match.record.participants[0];
    if (player.kind !== "human") throw Error("Expected human");
    if (change === "cpu") Object.assign(player, { kind: "cpu", level: 1 });
    if (change === "assigned") player.accountId = "assigned";
    if (change === "retired") player.retired = true;
    if (change === "duplicate")
      Object.assign(match.record.participants[1], { kind: "human", accountId: input.accountId });
    store.saved!.record_json = JSON.stringify(match.record);
    expect(await code(checkMatchClaim(store, input, decode))).toBe(
      change === "duplicate" ? "conflict" : "ineligible",
    );
  }
});
test("保存前に受け付けた不適格な請求があっても、適格な請求を順序どおり適用できる", async () => {
  const { store, input, row } = fixture();
  store.rows = [{ ...row, player_id: "missing" }, row, { ...row, account_id: null }];
  const result = await prepareMatchClaimTransitions(store, input.matchId, decode);
  expect(result?.transitions.map(({ row, valid }) => [row.player_id, valid])).toEqual([
    ["missing", false],
    [input.playerId, true],
    [input.playerId, false],
  ]);
  expect(store.calls).toEqual(["pending", "saved"]);
  store.saved = null;
  expect(await prepareMatchClaimTransitions(store, input.matchId, decode)).toBeNull();
  store.rows = [];
  store.calls = [];
  expect(await prepareMatchClaimTransitions(store, input.matchId, decode)).toBeNull();
  expect(store.calls).toEqual(["pending"]);
});
