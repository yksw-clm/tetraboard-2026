import { expect, test } from "bun:test";
import { readMatchReplayPage, createMatchChunk, type RecordMatch } from "../src";
import { matches } from "./readFixtures";
import { MemoryReadStore } from "./memoryReadStore";

for (const game of ["shogi", "four-shogi"] as const) {
  function fixture() {
    const store = new MemoryReadStore();
    const match = structuredClone(matches.find((m) => m.game === game)!);
    match.record.replay = { ...match.record.replay, eventCount: 205 } as typeof match.record.replay;
    store.records.push(match as Extract<RecordMatch, { game: "shogi" | "four-shogi" }>);
    const events = Array.from({ length: 205 }, (_, i) => i);
    store.chunks.set(
      match.record.id,
      [0, 1, 2].map((i) =>
        createMatchChunk(i, 205, events.slice(i * 100, i * 100 + 100), (e) => e),
      ),
    );
    return { store, id: match.record.id };
  }
  const read = (json: string) =>
    JSON.parse(json) as { replay: { eventCount: number; initial: unknown; rulesVersion: number } };
  const parse = (event: unknown): number => {
    if (typeof event !== "number") throw new Error("Invalid event");
    return event;
  };
  test(`${game}: 将棋ページはチャンク境界をまたぐ100件と末尾・空ページを返す`, async () => {
    for (const cursor of [0, 99, 100, 200, 205]) {
      const { store, id } = fixture();
      const page = await readMatchReplayPage(store, id, cursor, game, read, parse);
      const count = Math.min(100, 205 - cursor);
      expect(page?.events).toEqual(
        Array.from({ length: count }, (_, i) => ({ index: cursor + i, event: cursor + i })),
      );
      expect(page?.nextCursor).toBe(cursor + count < 205 ? cursor + count : null);
      if (cursor === 205) expect(store.calls).toEqual(["replay"]);
    }
  });
  test(`${game}: 不正cursor・本体なしを拒否し、必要なチャンクが欠けたら失敗する`, async () => {
    const { store, id } = fixture();
    for (const cursor of [-1, 0.5, 206])
      expect(await readMatchReplayPage(store, id, cursor, game, read, parse)).toBeNull();
    expect(await readMatchReplayPage(store, "missing", 0, game, read, parse)).toBeNull();
    store.chunks.get(id)!.splice(1, 1);
    await expect(readMatchReplayPage(store, id, 99, game, read, parse)).rejects.toThrow(
      "Missing stored",
    );
  });
  test(`${game}: 壊れたJSON・イベント・開始位置・重複チャンクを拒否する`, async () => {
    for (const corruption of ["json", "event", "start", "duplicate"]) {
      const { store, id } = fixture();
      const chunks = store.chunks.get(id)!;
      if (corruption === "json") chunks[0].events_json = "{";
      if (corruption === "event") chunks[0].events_json = JSON.stringify(Array(100).fill(null));
      if (corruption === "start") chunks[0].start_index++;
      if (corruption === "duplicate") chunks[1] = structuredClone(chunks[0]);
      await expect(readMatchReplayPage(store, id, 99, game, read, parse)).rejects.toThrow();
    }
  });
}
