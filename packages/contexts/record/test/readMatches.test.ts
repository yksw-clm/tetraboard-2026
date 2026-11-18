import { expect, test } from "bun:test";
import {
  readMatchDetail,
  readMatchDetailRecord,
  readMatchHistory,
  readMatchProfiles,
  type MatchParticipantClaim,
  readPublicMatches,
  publicMatchDetail,
  matchSummary,
  type RecordMatch,
  type HistoryQuery,
} from "../src";
import { MemoryReadStore } from "./memoryReadStore";
import { matches, stored, decode, validation } from "./readFixtures";

function fixture(match: RecordMatch) {
  const store = new MemoryReadStore();
  const saved = stored(match);
  store.records.push(saved.match);
  store.chunks.set(match.record.id, saved.chunks);
  store.history.set("self", new Set([match.record.id]));
  return store;
}
for (const original of matches) {
  test(`${original.game}: 本体・チャンクから詳細を復元し、公開応答と内部情報の除去を維持する`, async () => {
    const store = fixture(original);
    const profiles = new Map([["self", { name: "現在名", avatarUrl: "/current.png" }]]);
    const result = await readMatchDetail(
      store,
      original.record.id,
      undefined,
      validation,
      async () => {
        store.calls.push("profiles");
        return profiles;
      },
      true,
    );
    expect(result?.match).toEqual({
      ...publicMatchDetail(original, profiles),
      matchKind: "unknown",
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('"accountId"');
    expect(json).not.toContain('"instanceId"');
    expect(json).not.toContain('"selfPlayerId"');
    expect(store.calls).toEqual(
      original.game === "shogi" || original.game === "four-shogi"
        ? ["match", "profiles", "kinds:1"]
        : ["match", "chunks", "profiles", "kinds:1"],
    );
    if (original.record.participants.some((p) => p.kind === "human" && p.accountId === "self")) {
      const own = await readMatchDetail(
        store,
        original.record.id,
        "self",
        validation,
        async () => profiles,
      );
      expect(own?.match).toHaveProperty("selfPlayerId", original.record.participants[0].id);
    }
    expect(
      await readMatchDetail(store, original.record.id, "other", validation, async () => profiles),
    ).toBeNull();
  });
}
const snapshot = matches.find((m) => m.game === "four-reversi")!;
for (const corruption of ["missing", "json", "count", "order", "event"] as const) {
  test(`詳細は${corruption}のチャンクを拒否する`, async () => {
    const store = fixture(snapshot);
    const chunks = store.chunks.get(snapshot.record.id)!;
    if (corruption === "missing") chunks.pop();
    if (corruption === "json") chunks[0].events_json = "{";
    if (corruption === "count") chunks[0].event_count--;
    if (corruption === "order") chunks[0].chunk_index++;
    if (corruption === "event")
      chunks[0].events_json = JSON.stringify(Array(chunks[0].event_count).fill(null));
    const row = (await store.readMatch(snapshot.record.id))!;
    await expect(readMatchDetailRecord(store, row, validation)).rejects.toThrow();
  });
}
test("詳細は再生結果と保存された最終局面の相違、保存ゲームの相違を拒否する", async () => {
  const store = fixture(snapshot);
  const row = (await store.readMatch(snapshot.record.id))!;
  const value = JSON.parse(row.record_json);
  value.game.moveNumber++;
  await expect(
    readMatchDetailRecord(store, { ...row, record_json: JSON.stringify(value) }, validation),
  ).rejects.toThrow("final state");
  await expect(
    readMatchDetailRecord(store, { ...row, game: "gomoku" }, validation),
  ).rejects.toThrow("game mismatch");
});
const query: HistoryQuery = {
  accountId: "self",
  game: "four-reversi",
  mode: "singles",
  cursor: null,
  filter: "all",
};
function history(count: number) {
  const store = new MemoryReadStore();
  for (let i = 0; i < count; i++) {
    const match = structuredClone(stored(snapshot).match);
    match.record.id = `id-${String(i).padStart(3, "0")}`;
    match.record.startedAtMs = 100;
    match.record.participants = match.record.participants.map((p) => ({
      ...p,
      kind: "human",
      accountId: "self",
    })) as typeof match.record.participants;
    store.records.push(match);
  }
  store.history.set("self", new Set(store.records.map(({ record }) => record.id)));
  return store;
}
for (const count of [0, 20, 21, 41]) {
  test(`本人履歴${count}件を同時刻のID順で20件ずつ重複なく読む`, async () => {
    const store = history(count);
    const ids: string[] = [];
    let cursor: HistoryQuery["cursor"] = null;
    do {
      const page: Awaited<ReturnType<typeof readMatchHistory>> = await readMatchHistory(
        store,
        { ...query, cursor },
        decode,
        async () => new Map(),
        { includeMoveCount: true, includeMatchKind: true },
      );
      ids.push(...page.matches.map((m) => m.id));
      expect(page.matches.length).toBeLessThanOrEqual(20);
      expect(page.matches.every((m) => m.moveCount === snapshot.record.game.moveNumber)).toBe(true);
      const parts = page.nextCursor?.split(":");
      cursor = parts ? { startedAtMs: Number(parts[0]), id: parts[1] } : null;
    } while (cursor);
    expect(ids).toEqual(store.records.map(({ record }) => record.id).reverse());
    expect(new Set(ids).size).toBe(count);
  });
}
for (const filter of ["rated", "human", "cpu"] as const) {
  test(`本人履歴の${filter}条件を取得ポートへ渡し、適用した条件を応答する`, async () => {
    const store = history(45);
    for (const [index, match] of store.records.entries()) {
      store.kinds.set(match.record.id, index % 3 === 0 ? "rated" : "normal");
      if (index % 3 === 1)
        match.record.participants = match.record.participants.map((p) => ({
          ...p,
          kind: "cpu",
          level: 1,
        })) as typeof match.record.participants;
    }
    const page = await readMatchHistory(store, { ...query, filter }, decode, async () => new Map());
    expect(page.filter).toBe(filter);
    expect(page.matches.map((m) => m.id)).toEqual(
      store.records
        .filter((_, i) => i % 3 === (filter === "rated" ? 0 : filter === "cpu" ? 1 : 2))
        .map((m) => m.record.id)
        .reverse(),
    );
    expect(store.calls[0]).toBe(`history:${filter}`);
    expect(page.matches.every((m) => !("moveCount" in m) && !("matchKind" in m))).toBe(true);
  });
}
test("履歴は本人・ゲーム・モードで分離し、プロフィールを種別より先に一括取得する", async () => {
  const store = history(21);
  store.history.set("other", new Set());
  for (const condition of [
    { accountId: "other" },
    { game: "gomoku" as const },
    { mode: "doubles" as const },
  ]) {
    expect(
      (await readMatchHistory(store, { ...query, ...condition }, decode, async () => new Map()))
        .matches,
    ).toEqual([]);
  }
  store.calls = [];
  await readMatchHistory(
    store,
    query,
    decode,
    async (records) => {
      store.calls.push(`profiles:${records.length}`);
      return new Map();
    },
    { includeMatchKind: true },
  );
  expect(store.calls).toEqual(["history:all", "profiles:20", "kinds:20"]);
});
test("公開一覧とロビーはゲームと対人条件をポートへ渡し、最新20件を整形する", async () => {
  const store = history(25);
  for (const match of matches.filter((m) => m.game !== "four-reversi"))
    store.records.push(stored(match).match);
  for (const game of [undefined, "four-reversi"] as const)
    for (const humanOnly of [false, true]) {
      store.calls = [];
      const result = await readPublicMatches(
        store,
        game,
        humanOnly,
        decode,
        async (records) => {
          store.calls.push(`profiles:${records.length}`);
          return new Map();
        },
        { includeMatchKind: true },
      );
      expect(result.matches.length).toBe(20);
      expect(store.calls).toEqual([`public:${game}:${humanOnly}`, "profiles:20", "kinds:20"]);
      expect(
        result.matches.every(
          (m) =>
            (!game || m.game === game) &&
            (!humanOnly || m.participants.every((p) => p.kind === "human")),
        ),
      ).toBe(true);
    }
});
test("整形は保存名・現在のプロフィール・退会表示・CPUを保ち、レートの内部情報を除く", () => {
  const match = structuredClone(snapshot);
  Object.assign(match.record, {
    rating: { secret: 1 },
    profileRatings: { secret: 2 },
    fourReversiRating: { secret: 3 },
  });
  const profiles = new Map([["self", { name: "変更名", avatarUrl: "/icon" }]]);
  const summary = matchSummary(match, profiles);
  expect(summary.participants[0]).toMatchObject({ name: "変更名", avatarUrl: "/icon" });
  expect(JSON.stringify(publicMatchDetail(match, profiles))).not.toContain("secret");
  const human = match.record.participants[0];
  if (human.kind !== "human") throw new Error("Expected human");
  human.retired = true;
  human.accountId = null;
  human.name = "退会したプレイヤー";
  expect(matchSummary(match, profiles).participants[0]).toMatchObject({
    name: "退会したプレイヤー",
    retired: true,
    avatarUrl: null,
  });
});

test("本人の棋譜一覧では同じ参加者IDの引き継ぎを対局ごとに現在のプロフィールへ反映する", async () => {
  const store = history(2);
  const claims = store.records.map(({ record }, i): MatchParticipantClaim => {
    const player = record.participants[0];
    if (player.kind !== "human") throw new Error("Expected human fixture");
    player.accountId = null;
    return {
      match_id: record.id,
      player_id: player.id,
      account_id: `claimed-${i}`,
      state: "applied",
    };
  });
  const page = await readMatchHistory(store, query, decode, (records) =>
    readMatchProfiles(
      {
        readClaims: async (ids) => claims.filter(({ match_id }) => ids.includes(match_id)),
        readDeleted: async () => [],
      },
      records,
      async (ids) => new Map(ids.map((id) => [id, { name: id, avatarUrl: null }])),
      (record) => record,
    ),
  );
  expect(page.matches.map((match) => match.participants[0].name)).toEqual([
    "claimed-1",
    "claimed-0",
  ]);
  expect(page.nextCursor).toBeNull();
  expect(JSON.stringify(page)).not.toContain('"accountId"');
});
