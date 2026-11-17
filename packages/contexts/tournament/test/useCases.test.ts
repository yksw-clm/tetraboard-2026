import { expect, test } from "bun:test";
import {
  enroll,
  finalizeTournament,
  standingsPage,
  publicSummary,
  publicTournamentList,
  createDraft,
  updateDraft,
} from "../src";
import { row, score, policy, settings } from "./fixtures";
import { MemoryTournaments, MemoryFinalization } from "./memoryPorts";
const clock = { id: () => "entry", now: () => 1500 };
const ports = (store: MemoryTournaments, now = 2000) => ({ store, policy, now: () => now });

test("開催前と開催中だけエントリーを受け付け、再送で増やさない", async () => {
  for (const now of [999, 1000, 1999]) {
    const store = new MemoryTournaments();
    for (let retry = 0; retry < 2; retry++)
      expect(
        await enroll(store, store, "tournament", "account", { ...clock, now: () => now }),
      ).toEqual({ ok: true });
    expect(store.entries.size).toBe(1);
  }
  for (const tournament of [
    null,
    row({ published: 0 }),
    row({ finalized_at_ms: 2000 }),
    row({ ends_at_ms: 1500 }),
  ]) {
    const store = new MemoryTournaments();
    store.tournament = tournament;
    expect(await enroll(store, store, "tournament", "account", clock)).toEqual({
      ok: false,
      status: 409,
      message: "エントリー受付は終了しました。",
    });
    expect(store.entries.size).toBe(0);
  }
});

test("プロフィール未完成者はエントリーせず403を返す", async () => {
  const store = new MemoryTournaments();
  store.validAccounts.clear();
  expect(await enroll(store, store, "tournament", "account", clock)).toEqual({
    ok: false,
    status: 403,
    message: "プロフィール登録を完了してください。",
  });
  expect(store.entries.size).toBe(0);
});

test("終了前・未公開・未解決対局ありでは結果を確定しない", async () => {
  for (const [tournament, now, pending] of [
    [null, 2000, false],
    [row({ published: 0 }), 2000, false],
    [row(), 1999, false],
    [row(), 2000, true],
  ] as const) {
    const store = new MemoryTournaments();
    store.tournament = tournament;
    const final = new MemoryFinalization(store);
    final.unresolved = pending;
    await finalizeTournament(ports(store), final, "tournament", now);
    expect(final.events).toEqual([]);
  }
});

test("全員の順位、上位の同率通知、確定の順に保存し再実行で変えない", async () => {
  const store = new MemoryTournaments();
  store.scores = [score("b"), score("a"), score("c", { games: 0 })];
  const final = new MemoryFinalization(store);
  await finalizeTournament(ports(store), final, "tournament");
  expect(final.events).toEqual(["rank:a", "rank:b", "notification:a", "notification:b", "finish"]);
  expect(final.notifications).toEqual(
    Array.from({ length: 2 }, () => ({ id: 1, name: "大会", rank: 1, tied: true })),
  );
  expect(store.scores.map((s) => s.finalRank)).toEqual([1, 1, null]);
  await finalizeTournament(ports(store, 3000), final, "tournament");
  expect(final.events).toHaveLength(5);
  expect(store.tournament!.finalized_at_ms).toBe(2000);
});

test("0局でも締切で確定し、未対局者へ順位と通知を作らない", async () => {
  const store = new MemoryTournaments();
  store.scores = [score("a", { games: 0 })];
  const final = new MemoryFinalization(store);
  await finalizeTournament(ports(store), final, "tournament");
  expect(final.events).toEqual(["finish"]);
  expect(store.scores[0]!.finalRank).toBeNull();
});

test("読取後に参加者か未解決局が変わると確定を拒否する", async () => {
  for (const change of ["entries", "pending"]) {
    const store = new MemoryTournaments();
    store.scores = [score("a")];
    const final = new MemoryFinalization(store);
    final.beforeBatch = () => {
      if (change === "entries") store.scores.push(score("b"));
      else final.unresolved = true;
    };
    await finalizeTournament(ports(store), final, "tournament");
    expect(final.events).toEqual([]);
    expect(store.tournament!.finalized_at_ms).toBeNull();
  }
});

test("開催前は本人戦績も返さず、5位の同順位と未対局の本人を表示する", async () => {
  const store = new MemoryTournaments();
  store.scores = Array.from({ length: 7 }, (_, i) =>
    score(String(i), { pointsUnits: i < 4 ? 120 - i * 12 : 12, games: i === 6 ? 0 : 1 }),
  );
  expect(await standingsPage(ports(store, 999), row(), "account-6")).toEqual({
    standings: [],
    self: null,
    nextCursor: null,
  });
  const page = await standingsPage(ports(store, 1500), row(), "account-6");
  expect(page.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 5]);
  expect(page.self).toMatchObject({ games: 0, rank: null, self: true });
  expect(JSON.stringify(page)).not.toContain("account-");
});

test("公開概要と一覧は現在の人数を返し、確定前の優勝者を作らない", async () => {
  const store = new MemoryTournaments();
  store.entries.set("account", "entry");
  store.scores = [score("a", { finalRank: 1 })];
  expect(await publicSummary(ports(store), row())).toMatchObject({
    entryCount: 1,
    status: "settling",
    pendingCount: 0,
  });
  expect(
    (await publicTournamentList(ports(store), "all", undefined, 2000)).tournaments[0]!.winners,
  ).toEqual([]);
  store.tournament!.finalized_at_ms = 2000;
  expect(
    (await publicTournamentList(ports(store), "all", undefined, 2000)).tournaments[0]!.winners,
  ).toEqual([{ name: "a", avatarUrl: "/avatar/a" }]);
});

test("下書きのIDと時刻をポートから受け取り、古い版の保存を拒否する", async () => {
  const store = new MemoryTournaments();
  const input = {
    name: "下書き",
    description: "",
    rulesDescription: "",
    startsAtMs: null,
    endsAtMs: null,
    settings,
  };
  expect(await createDraft(store, input, { id: () => "draft", now: () => 123 })).toBe("draft");
  expect(store.tournament).toMatchObject({
    key: "draft",
    rule_version: 2,
    created_at_ms: 123,
    published: 0,
  });
  expect(await updateDraft(store, "draft", { ...input, name: "修正" }, 1, () => 456)).toBe(true);
  expect(await updateDraft(store, "draft", input, 1, () => 789)).toBe(false);
  expect(store.tournament).toMatchObject({ name: "修正", version: 2, updated_at_ms: 456 });
});
