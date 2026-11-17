import { expect, test } from "bun:test";
import {
  enqueue,
  cancel,
  heartbeat,
  claimController,
  tick,
  participation,
  entryStatuses,
  purgeAccount,
  cancelForAccount,
  publish,
  recoverTournaments,
  selectFour,
  connectionDeadline,
} from "../src";
import { QueueFixture } from "./queueMemory";

const join = (f: QueueFixture, i: number) =>
  enqueue(f, f.state, `a${i}`, `w${i}`, `hash${i}`, `tab${i}`);
async function matched() {
  const f = new QueueFixture();
  for (let i = 1; i <= 4; i++) expect(await join(f, i)).toEqual({ ok: true });
  return f;
}

test("待機の参加・再送・継続・取消で同じ操作を復活させない", async () => {
  const f = new QueueFixture(1);
  expect(await join(f, 1)).toEqual({ ok: true });
  expect(await join(f, 1)).toEqual({ ok: true });
  expect(await participation(f, f.state, "a1", "tab1")).toEqual({
    entered: true,
    status: "waiting",
    controller: "self",
    controllerVersion: 1,
    operationId: "w1",
    expiresAtMs: 31000,
  });
  f.time = 2000;
  expect(await heartbeat(f, f.state, "a1", "w1", "tab1", 1)).toEqual({ ok: true });
  expect(f.state.waiting[0]!.expiresAtMs).toBe(32000);
  expect(await cancel(f, f.state, "a1", "w1", "tab1", 1)).toEqual({ ok: true });
  expect(f.store.leases.size).toBe(0);
  expect(f.storage.fences.has("cancel:w1")).toBe(true);
  expect(await join(f, 1)).toMatchObject({ ok: false, status: 409 });
});

test("先着取消は初期世代だけを失効させる", async () => {
  const f = new QueueFixture(1);
  await cancel(f, f.state, "a1", "w1", "tab1", 1);
  expect(await join(f, 1)).toMatchObject({ ok: false, status: 409 });
  expect(await enqueue(f, f.state, "a1", "w1", "hash1", "tab2")).toEqual({ ok: true });
  expect(f.storage.fences).toEqual(new Set(["cancel-controller:w1:tab1:1"]));
});

test("引き継ぎと同じ要求の再送は期限を変えず、旧操作を取消印より前に拒否する", async () => {
  const f = new QueueFixture(1);
  await join(f, 1);
  const input = {
    operationId: "w1",
    controllerId: "new",
    takeover: true,
    expectedControllerVersion: 1,
  };
  const result = await claimController(f, f.state, "a1", input);
  expect(result).toMatchObject({
    ok: true,
    participation: { controller: "self", controllerVersion: 2, expiresAtMs: 31000 },
  });
  expect(await claimController(f, f.state, "a1", input)).toEqual(result);
  expect(await heartbeat(f, f.state, "a1", "w1", "tab1", 1)).toEqual({
    ok: false,
    status: 409,
    message: "操作元が別のタブに移りました。",
  });
  expect(await cancel(f, f.state, "a1", "w1", "tab1", 1)).toMatchObject({ ok: false, status: 409 });
  expect(f.storage.fences.size).toBe(0);
  expect(JSON.stringify(f.storage.saved)).not.toContain('"token"');
});

test("旧owner無しの保存状態から世代0を引き継ぎ、古いCASを拒否する", async () => {
  const f = new QueueFixture(1);
  await enqueue(f, f.state, "a1", "w1", "old-hash");
  f.state = structuredClone(f.storage.saved!);
  expect(
    await claimController(f, f.state, "a1", {
      operationId: "w1",
      controllerId: "new",
      takeover: true,
      expectedControllerVersion: 0,
    }),
  ).toMatchObject({ ok: true, participation: { controllerVersion: 1 } });
  expect(
    await claimController(f, f.state, "a1", {
      operationId: "w1",
      controllerId: "other",
      takeover: true,
      expectedControllerVersion: 0,
    }),
  ).toMatchObject({ ok: false, status: 409 });
});

test("固定乱数で4人を選び、別の待機は残し入力を変更しない", async () => {
  const f = new QueueFixture(5);
  const waits = [...f.profiles.keys()].map((accountId, i) => ({
    accountId,
    operationId: `w${i + 1}`,
    tokenHash: `hash${i}`,
    expiresAtMs: 31000,
  }));
  expect(selectFour(waits, () => 0).map((w) => w.accountId)).toEqual(["a2", "a3", "a4", "a5"]);
  expect(waits.map((w) => w.accountId)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  const formed = await matched();
  expect(formed.state.groups[0]).toMatchObject({
    id: "id1",
    instanceId: "id2",
    roomId: "12345",
    phase: "matched",
    expiresAtMs: 31000,
  });
  expect(formed.prepared[0]!.players.map((p) => p.admission.accountId)).toEqual([
    "a1",
    "a2",
    "a3",
    "a4",
  ]);
  expect(formed.prepared[0]!.players[3]!.admission.isGuest).toBe(true);
  expect(formed.prepared[0]!.context.matchSequence).toBe(1);
  expect(formed.store.seats.size).toBe(4);
  expect(formed.store.leases.size).toBe(0);
  expect(await entryStatuses(formed, formed.state)).toEqual({
    a1: "matched",
    a2: "matched",
    a3: "matched",
    a4: "matched",
  });
});

test.each(["local", "lease"])(
  "%s の期限ちょうどで待機を失効し、読み取りで回収せずAlarmで回収する",
  async (source) => {
    const f = new QueueFixture(1);
    await join(f, 1);
    if (source === "local") f.state.waiting[0]!.expiresAtMs = 2000;
    else f.store.leases.get("a1")!.expiresAtMs = 2000;
    f.time = 1999;
    expect((await participation(f, f.state, "a1")).status).toBe("waiting");
    f.time = 2000;
    expect((await participation(f, f.state, "a1")).status).toBe("idle");
    expect(f.state.waiting.length).toBe(1);
    expect(await heartbeat(f, f.state, "a1", "w1", "tab1", 1)).toMatchObject({ ok: false });
    await tick(f, f.state);
    expect(f.state.waiting).toEqual([]);
    expect(f.store.leases.size).toBe(0);
  },
);

test("成立後のheartbeatと資格引き継ぎは入室猶予を延長しない", async () => {
  const f = await matched();
  f.time = 2000;
  expect(await heartbeat(f, f.state, "a1", "w1", "tab1", 1)).toEqual({ ok: true });
  const input = {
    operationId: "w1",
    controllerId: "new",
    takeover: true,
    expectedControllerVersion: 1,
  };
  f.rekeyFailure = true;
  await expect(claimController(f, f.state, "a1", input)).rejects.toThrow("RPC failed");
  const saved = f.storage.saved!;
  expect(saved.groups[0]!.players[0]).toMatchObject({
    credentialPending: true,
    controllerVersion: 2,
  });
  f.state = structuredClone(saved);
  f.rekeyFailure = false;
  await tick(f, f.state);
  expect(f.state.groups[0]!.expiresAtMs).toBe(31000);
  expect(await claimController(f, f.state, "a1", input)).toMatchObject({
    ok: true,
    participation: { roomId: "12345", matchId: "id1", controllerVersion: 2 },
  });
});

test("移譲のbatch失敗後も保存した同じ組を再準備する", async () => {
  const f = new QueueFixture();
  for (let i = 1; i < 4; i++) await join(f, i);
  f.store.failCommit = true;
  await expect(join(f, 4)).rejects.toThrow("seat batch failed");
  expect(f.store.seats.size).toBe(0);
  expect(f.storage.saved!.groups[0]).toMatchObject({ id: "id1", phase: "preparing" });
  expect((await participation(f, f.state, "a1")).status).toBe("waiting");
  f.state = structuredClone(f.storage.saved!);
  f.state.groups[0]!.phase = "confirming";
  f.store.failCommit = false;
  await tick(f, f.state);
  expect(f.state.groups[0]).toMatchObject({ id: "id1", phase: "matched" });
  expect(f.prepared).toHaveLength(1);
});

test("入室期限の直前は維持し、期限ちょうどで接続した人だけを再待機させる", async () => {
  const f = await matched();
  f.roomState.connectedPlayerIds = [f.state.groups[0]!.players[1]!.admission.playerId];
  f.time = 30999;
  await tick(f, f.state);
  expect(f.state.groups).toHaveLength(1);
  f.time = 31000;
  await tick(f, f.state);
  expect(f.state.groups).toEqual([]);
  expect(f.state.waiting.map((w) => w.accountId)).toEqual(["a2"]);
  expect(f.state.waiting[0]!.expiresAtMs).toBe(61000);
  expect(f.released).toHaveLength(4);
  expect(f.store.ledger.get("id1")).toBe("aborted");
});

test("準備途中で入室期限に達した組は、保存状態から復旧しても誰も再待機させない", async () => {
  const f = new QueueFixture();
  for (let i = 1; i < 4; i++) await join(f, i);
  f.store.failCommit = true;
  await expect(join(f, 4)).rejects.toThrow("seat batch failed");
  f.state = structuredClone(f.storage.saved!);
  f.time = 31000;
  f.store.failCommit = false;
  await tick(f, f.state);
  expect(f.state).toEqual({ key: "tournament", waiting: [], groups: [] });
  expect(f.prepared).toEqual([]);
  expect(f.store.leases.size).toBe(0);
});

test("終了の境界では新しい開始を回収し、開始確認済みなら終了後も進行中を保つ", async () => {
  expect(connectionDeadline(1000, 30000, 2000)).toBe(2000);
  const f = await matched();
  f.time = f.definition.ends_at_ms!;
  await tick(f, f.state);
  expect(f.state.groups).toEqual([]);
  expect(f.state.waiting).toEqual([]);
  const started = await matched();
  started.roomState.startedAtMs = 2000;
  started.time = started.definition.ends_at_ms!;
  await tick(started, started.state);
  expect(started.state.groups[0]!.phase).toBe("playing");
  expect(started.released).toEqual([]);
});

test("明示取消は本人を除外し、補償中に開始済みの応答が来たら席を解放しない", async () => {
  const f = await matched();
  await cancel(f, f.state, "a1", "w1", "tab1", 1);
  expect(f.state.waiting.map((w) => w.accountId)).toEqual(["a2", "a3", "a4"]);
  expect(f.state.groups).toEqual([]);
  const started = await matched();
  started.abortResult = "already_started";
  await cancel(started, started.state, "a1", "w1", "tab1", 1);
  expect(started.state.groups[0]!.phase).toBe("playing");
  expect(started.released).toEqual([]);
  expect(started.store.seats.size).toBe(4);
});

test("退会は待機を失効し、未開始の組から本人を外し、開始済みでは本人情報だけを除く", async () => {
  const waiting = new QueueFixture(1);
  await join(waiting, 1);
  waiting.profiles.delete("a1");
  await purgeAccount(waiting, waiting.state, "a1");
  expect(waiting.storage.saved!.waiting).toEqual([]);
  expect(waiting.storage.fences.has("cancel:w1")).toBe(true);
  const f = await matched();
  f.profiles.delete("a1");
  await purgeAccount(f, f.state, "a1");
  expect(f.state.waiting.map((w) => w.accountId)).toEqual(["a2", "a3", "a4"]);
  const started = await matched();
  started.state.groups[0]!.phase = "playing";
  started.profiles.delete("a1");
  await purgeAccount(started, started.state, "a1");
  expect(started.state.groups[0]!.players.map((p) => p.accountId)).toEqual(["a2", "a3", "a4"]);
  expect(started.released).toEqual([]);
});

test("ログアウトは未開始を取り消し、開始済みの割り当ては保持する", async () => {
  const f = await matched();
  await cancelForAccount(f, f.state, "a1");
  expect(f.state.waiting.map((w) => w.accountId)).toEqual(["a2", "a3", "a4"]);
  const started = await matched();
  started.state.groups[0]!.phase = "playing";
  await cancelForAccount(started, started.state, "a1");
  expect(started.state.groups[0]!.players).toHaveLength(4);
  expect(started.released).toEqual([]);
});

test("公開は版と未来の日時と既公開の終了境界を検査して連番を確定し、復旧を登録する", async () => {
  const f = new QueueFixture(0);
  Object.assign(f.definition, { published: 0, public_id: null, starts_at_ms: 5000 });
  f.store.latest = { id: 8, ends: 5000 };
  expect(await publish(f, "tournament", 0)).toMatchObject({ ok: false, status: 409 });
  f.definition.starts_at_ms = 4999;
  expect(await publish(f, "tournament", 1)).toMatchObject({ ok: false, status: 400 });
  f.definition.starts_at_ms = 1000;
  expect(await publish(f, "tournament", 1)).toMatchObject({ ok: false, status: 400 });
  f.definition.starts_at_ms = 5000;
  f.store.failPublish = true;
  expect(await publish(f, "tournament", 1)).toMatchObject({ ok: false, status: 409 });
  f.store.failPublish = false;
  expect(await publish(f, "tournament", 1)).toEqual({ ok: true });
  expect(f.definition).toMatchObject({
    published: 1,
    public_id: 9,
    version: 2,
    updated_at_ms: 1000,
  });
  expect(f.refreshed).toEqual(["tournament"]);
  expect(await publish(f, "tournament", 2)).toMatchObject({ ok: false, status: 409 });
});

test("復旧は期限切れ待機の掃除の後に取得順で直列に進める", async () => {
  const events: string[] = [];
  await recoverTournaments({
    expireWaiting: async () => {
      events.push("expire");
    },
    pending: async () => {
      events.push("read");
      return [{ key: "b" }, { key: "a" }];
    },
    refresh: async (key) => {
      events.push(key);
    },
  });
  expect(events).toEqual(["expire", "read", "b", "a"]);
});
