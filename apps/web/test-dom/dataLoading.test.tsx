import { expect, test } from "bun:test";
import { useAccountStats } from "../src/features/account/useAccountStats";
import { useMatchHistory } from "../src/features/account/useMatchHistory";
import { useAccountSelection } from "../src/features/account/useAccountSelection";
import { useRankings } from "../src/features/lobby/useRankings";
import { useLobby } from "../src/features/lobby/useLobby";
import { useRecentMatches } from "../src/features/matches/useRecentMatches";
import { match } from "../test/fixtures/matchSummary";
import { shogiStats } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, requests, renderHook, wrap } from "./harness";

const stats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
const rankings = { singles: { first: [], total: [] }, doubles: { wins: [], total: [] } };
test("取得の操作元は初回・自動更新と区別し、古い応答で新しい処理中表示を解除しない", async () => {
  const lobby = renderHook(useLobby, "four-reversi" as const);
  clock.advance(0);
  expect(lobby.current.pendingSource).toBeNull();
  requests.at(-1)!.respond({ rooms: [], nextCursor: null });
  await flush();
  act(() => {
    void lobby.current.refresh("refresh");
  });
  const old = requests.at(-1)!;
  expect(lobby.current.pendingSource).toBe("refresh");
  act(() => {
    void lobby.current.refresh("refresh");
  });
  old.respond({ rooms: [], nextCursor: null });
  await flush();
  expect(lobby.current.pendingSource).toBe("refresh");
  requests.at(-1)!.respond({}, 503);
  await flush();
  expect(lobby.current.pendingSource).toBeNull();
  clock.advance(10_000);
  expect(lobby.current.loading).toBe(true);
  expect(lobby.current.pendingSource).toBeNull();

  const ranking = renderHook(useRankings, "four-reversi" as const);
  clock.advance(0);
  requests.at(-1)!.respond({}, 503);
  await flush();
  act(() => {
    void ranking.current.refresh("dialog-retry");
  });
  expect(ranking.current.pendingSource).toBe("dialog-retry");
  expect(ranking.current.error).not.toBeNull();
  requests.at(-1)!.respond(rankings);
  await flush();
  expect(ranking.current.pendingSource).toBeNull();
  expect(ranking.current.error).toBeNull();
});
test("戦績はloading・schema失敗・再試行を区別し、更新失敗時は値を保持", async () => {
  const h = renderHook(useAccountStats, "four-reversi" as const);
  expect(h.current.loading).toBe(true);
  clock.advance(0);
  requests[0]!.respond({});
  await flush();
  expect(h.current.loading).toBe(false);
  expect(h.current.stats).toBeNull();
  expect(h.current.error).not.toBeNull();
  act(() => {
    void h.current.refresh();
  });
  requests[1]!.respond(stats);
  await flush();
  expect(h.current.stats).toEqual(stats);
  act(() => {
    void h.current.refresh();
  });
  expect(h.current.stats).toEqual(stats);
  expect(h.current.loading).toBe(true);
  requests[2]!.respond({}, 503);
  await flush();
  expect(h.current.stats).toEqual(stats);
  expect(h.current.error).not.toBeNull();
  act(() => {
    void h.current.refresh();
  });
  requests[3]!.respond({ ...stats, singles: { ...stats.singles, total: 13, first: 5 } });
  await flush();
  expect(h.current.stats?.singles.total).toBe(13);
});
test("各ゲームの戦績を独立して取得し、遅い旧更新とunmount後の応答を破棄", async () => {
  const h = renderHook(useAccountStats, "four-reversi" as "four-reversi" | "four-shogi");
  clock.advance(0);
  h.rerender("four-shogi");
  clock.advance(0);
  expect(requests[1]!.url).toContain("game=four-shogi");
  requests[1]!.respond(shogiStats);
  await flush();
  expect(h.current.stats).toEqual(shogiStats);
  requests[0]!.respond(stats);
  await flush();
  expect(h.current.stats).toEqual(shogiStats);
  h.rerender("four-reversi");
  expect(h.current.stats).toEqual(stats);
  act(() => {
    void h.current.refresh();
  });
  act(() => {
    void h.current.refresh();
  });
  expect(requests[2]!.init.signal?.aborted).toBe(true);
  requests[3]!.respond(stats);
  requests[2]!.respond({ ...stats, singles: { ...stats.singles, total: 999 } });
  await flush();
  expect(h.current.stats?.singles.total).toBe(12);
  act(() => {
    void h.current.refresh();
  });
  h.unmount();
  expect(requests[4]!.init.signal?.aborted).toBe(true);
  requests[4]!.respond(stats);
  await flush();
});
test("戦績・履歴はゲームとモードを独立して保存し、履歴stateから復元", () => {
  const h = renderHook(
    () => ({ stats: useAccountSelection("stats"), history: useAccountSelection("history") }),
    undefined,
    wrap(),
  );
  act(() => h.current.stats.setGame("four-shogi"));
  act(() => h.current.stats.setMode("doubles"));
  expect(h.current.history.game).toBe("four-reversi");
  expect(h.current.history.mode).toBe("singles");
  act(() => h.current.history.setMode("doubles"));
  act(() => h.current.stats.setGame("four-reversi"));
  expect(h.current.stats.mode).toBe("singles");
  act(() => h.current.stats.setGame("four-shogi"));
  expect(h.current.stats.mode).toBe("doubles");
  expect(h.current.history.mode).toBe("doubles");
});
test("履歴の追加は二重取得せず重複を除き、追加失敗は同じcursorで再試行", async () => {
  const h = renderHook(useMatchHistory, undefined, wrap());
  clock.advance(0);
  requests[0]!.respond({ matches: [match(1)], nextCursor: "next" });
  await flush();
  act(() => {
    void h.current.loadMore();
    void h.current.loadMore();
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toContain("cursor=next");
  requests[1]!.respond({}, 503);
  await flush();
  expect(h.current.page.matches).toHaveLength(1);
  expect(h.current.page.failedMore).toBe(true);
  act(() => {
    void h.current.retry();
  });
  expect(requests[2]!.url).toBe(requests[1]!.url);
  requests[2]!.respond({ matches: [match(1), match(2)], nextCursor: null });
  await flush();
  expect(h.current.page.matches.map((m) => m.id)).toEqual([match(1).id, match(2).id]);
  act(() => h.current.setMode("doubles"));
  clock.advance(0);
  requests[3]!.respond({ matches: [], nextCursor: null });
  await flush();
  expect(h.current.page.matches).toHaveLength(0);
  act(() => h.current.setMode("singles"));
  expect(h.current.page.matches).toHaveLength(2);
  act(() => {
    void h.current.refresh();
  });
  expect(h.current.page.matches).toHaveLength(2);
  requests[4]!.respond({}, 503);
  await flush();
  expect(h.current.page.matches).toHaveLength(2);
});
test("履歴は別ゲーム・モードのschema応答を拒否し、切替後の応答を混ぜない", async () => {
  const h = renderHook(useMatchHistory, undefined, wrap());
  clock.advance(0);
  act(() => h.current.setGame("four-shogi"));
  clock.advance(0);
  requests[1]!.respond({ matches: [match(1)], nextCursor: null });
  await flush();
  expect(h.current.page.error).not.toBeNull();
  expect(h.current.page.matches).toHaveLength(0);
  requests[0]!.respond({ matches: [match(1)], nextCursor: null });
  await flush();
  expect(h.current.page.matches).toHaveLength(0);
  act(() => h.current.setGame("four-reversi"));
  expect(h.current.page.matches).toHaveLength(1);
});
test("ランキングはゲーム別API、失敗時保持、更新によるabortと再試行", async () => {
  const h = renderHook(useRankings, "four-reversi" as "four-reversi" | "four-shogi");
  clock.advance(0);
  expect(requests[0]!.url).toBe("/api/games/four-reversi/rankings");
  requests[0]!.respond(rankings);
  await flush();
  act(() => {
    void h.current.refresh();
  });
  requests[1]!.respond({}, 503);
  await flush();
  expect(h.current.rankings).toEqual(rankings);
  act(() => {
    void h.current.refresh();
  });
  h.rerender("four-shogi");
  expect(requests[2]!.init.signal?.aborted).toBe(true);
  clock.advance(0);
  expect(requests[3]!.url).toBe("/api/games/four-shogi/rankings");
  requests[2]!.respond(rankings);
  requests[3]!.respond(rankings);
  await flush();
  expect(h.current.error).toBeNull();
  expect(h.current.loading).toBe(false);
});
test("ロビーは初回失敗・追加失敗・末尾を区別し、追加後の自動更新を抑止", async () => {
  const h = renderHook(useLobby, "four-shogi" as const);
  clock.advance(0);
  expect(requests[0]!.url).toContain("game=four-shogi");
  requests[0]!.respond({}, 503);
  await flush();
  expect(h.current.error).not.toBeNull();
  act(() => {
    void h.current.refresh();
  });
  requests[1]!.respond({ rooms: [], nextCursor: "1:12345" });
  await flush();
  act(() => {
    void h.current.loadMore();
  });
  requests[2]!.respond({}, 503);
  await flush();
  expect(h.current.nextCursor).toBe("1:12345");
  act(() => {
    void h.current.loadMore();
  });
  requests[3]!.respond({ rooms: [], nextCursor: null });
  await flush();
  clock.advance(10000);
  expect(requests).toHaveLength(4);
  expect(h.current.nextCursor).toBeNull();
});
test("公開履歴の集計条件を変更すると旧結果を消去し、遅延応答をabortして破棄", async () => {
  const h = renderHook(useRecentMatches, "four-reversi" as const);
  clock.advance(0);
  act(() => h.current.changeHumanOnly(true));
  expect(requests[0]!.init.signal?.aborted).toBe(true);
  clock.advance(0);
  expect(requests[1]!.url).toContain("humanOnly=true");
  requests[1]!.respond({ matches: [] });
  await flush();
  requests[0]!.respond({ matches: [match(1)] });
  await flush();
  expect(h.current.matches).toHaveLength(0);
  expect(h.current.error).toBeNull();
});
