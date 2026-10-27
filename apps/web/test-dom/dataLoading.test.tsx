import { expect, test } from "bun:test";
import { lobbyRoomCardSchema } from "@tetraboard/protocol/general-lobby";
import { useAccountStats } from "../src/features/account/useAccountStats";
import { useMatchHistory } from "../src/features/account/useMatchHistory";
import { useAccountSelection } from "../src/features/account/useAccountSelection";
import { useRankings } from "../src/features/lobby/useRankings";
import { useLobby } from "../src/features/lobby/useLobby";
import { useRecentMatches } from "../src/features/matches/useRecentMatches";
import { match } from "../test/fixtures/matchSummary";
import { shogiStats } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, requests, renderHook, wrap } from "./harness";

function useSelectedHistory() {
  const selection = useAccountSelection();
  return { ...selection, ...useMatchHistory(selection.game, selection.mode) };
}

const stats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
const rankings = { singles: { first: [], total: [] }, doubles: { wins: [], total: [] } };
test("cards取得の失敗は同条件で再試行し、ランキングの旧Worker互換を維持する", async () => {
  const lobby = renderHook(useLobby, "four-reversi" as const);
  clock.advance(0);
  expect(requests.at(-1)!.url).toBe("/api/lobby/rooms?view=cards&game=four-reversi");
  requests.at(-1)!.respond({}, 400);
  await flush();
  expect(lobby.current.error).not.toBeNull();
  expect(requests).toHaveLength(1);
  act(() => void lobby.current.refresh());
  requests.at(-1)!.respond({ rooms: [], nextCursor: null, totalCount: 0 });
  await flush();
  expect(lobby.current.error).toBeNull();
  const ranking = renderHook(useRankings, "four-shogi" as const);
  clock.advance(0);
  requests.at(-1)!.respond({}, 400);
  await flush();
  expect(requests.at(-1)!.url).toBe("/api/games/four-shogi/rankings");
  requests.at(-1)!.respond(rankings);
  await flush();
  expect(ranking.current.error).toBeNull();
});
test("一覧の重複更新を防ぎ、ローカル条件切替は取得中の通信と操作元を維持する", async () => {
  const lobby = renderHook(useLobby, "four-reversi" as const);
  clock.advance(0);
  requests.at(-1)!.respond({ rooms: [], nextCursor: null, totalCount: 0 });
  await flush();
  act(() => void lobby.current.refresh("refresh"));
  const pending = requests.at(-1)!;
  const count = requests.length;
  expect(lobby.current.pendingSource).toBe("refresh");
  act(() => {
    void lobby.current.refresh("refresh");
    lobby.current.changeMode("doubles");
    lobby.current.changeJoinable(true);
  });
  expect(requests).toHaveLength(count);
  expect(pending.init.signal?.aborted).toBe(false);
  expect(lobby.current.pendingSource).toBe("refresh");
  expect(pending.url).not.toContain("mode=");
  expect(pending.url).not.toContain("joinable=");
  const double = lobbyCard("12345", { mode: "doubles" });
  const playing = lobbyCard("12346", { mode: "doubles", status: "playing", openSeats: 0 });
  pending.respond({
    rooms: [double, playing, lobbyCard("12347")],
    nextCursor: null,
    totalCount: 999,
  });
  await flush();
  expect(lobby.current.rooms.map((room) => room.id)).toEqual(["12345"]);
  expect(lobby.current.totalCount).toBe(1);
  expect(lobby.current.loading).toBe(false);
  expect(lobby.current.pendingSource).toBeNull();
  clock.advance(10_000);
  expect(lobby.current.pendingSource).toBeNull();
  requests.at(-1)!.respond({}, 503);
  await flush();
  expect(lobby.current.error).not.toBeNull();
  const afterRefresh = requests.length;
  act(() => lobby.current.changeJoinable(false));
  expect(lobby.current.rooms.map((room) => room.id)).toEqual(["12345", "12346"]);
  expect(lobby.current.totalCount).toBe(2);
  expect(lobby.current.loading).toBe(false);
  expect(lobby.current.error).not.toBeNull();
  expect(requests).toHaveLength(afterRefresh);

  const ranking = renderHook(useRankings, "four-reversi" as const);
  clock.advance(0);
  requests.at(-1)!.respond({}, 503);
  await flush();
  act(() => void ranking.current.refresh("dialog-retry"));
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
  expect(
    (h.current.stats && "singles" in h.current.stats ? h.current.stats.singles : null)?.total,
  ).toBe(13);
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
  expect(
    (h.current.stats && "singles" in h.current.stats ? h.current.stats.singles : null)?.total,
  ).toBe(12);
  act(() => {
    void h.current.refresh();
  });
  h.unmount();
  expect(requests[4]!.init.signal?.aborted).toBe(true);
  requests[4]!.respond(stats);
  await flush();
});
test("共通のゲーム・モードを保持し、ゲームごとのモードを復元", () => {
  const h = renderHook(useAccountSelection, undefined, wrap());
  expect(h.current.game).toBe("four-reversi");
  expect(h.current.mode).toBe("singles");
  act(() => h.current.setGame("four-shogi"));
  act(() => h.current.setMode("doubles"));
  act(() => h.current.setGame("four-reversi"));
  expect(h.current.mode).toBe("singles");
  act(() => h.current.setGame("four-shogi"));
  expect(h.current.mode).toBe("doubles");
});
test("履歴の追加は二重取得せず重複を除き、追加失敗は同じcursorで再試行", async () => {
  const h = renderHook(useSelectedHistory, undefined, wrap());
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
  const h = renderHook(useSelectedHistory, undefined, wrap());
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
  expect(requests[0]!.url).toBe("/api/games/four-reversi/rankings?profilePreview=1");
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
  expect(requests[3]!.url).toBe(
    "/api/games/four-shogi/rankings?profilePreview=1&includeKnockouts=1",
  );
  requests[2]!.respond(rankings);
  requests[3]!.respond(rankings);
  await flush();
  expect(h.current.error).toBeNull();
  expect(h.current.loading).toBe(false);
});
function lobbyCard(id: string, values: Record<string, unknown> = {}) {
  return lobbyRoomCardSchema.parse({
    id,
    instanceId: "00000000-0000-4000-8000-000000000001",
    game: "four-reversi",
    mode: "singles",
    timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
    status: "waiting",
    hostName: "ホスト",
    humanCount: 1,
    cpuCount: 0,
    capacity: 4,
    openSeats: 3,
    updatedAtMs: 1,
    participants: [{ kind: "human", avatarUrl: null, profileTarget: null }],
    ...values,
  });
}
test("20件目より後の対象も全取得して一括表示し、更新途中の失敗は以前の全件を保つ", async () => {
  const first = {
    rooms: Array.from({ length: 20 }, (_, index) => lobbyCard(String(12345 + index))),
    nextCursor: "0:1:12345",
    totalCount: 22,
  };
  const doubles = [
    lobbyCard("23456", { mode: "doubles" }),
    lobbyCard("23457", { mode: "doubles", status: "playing", openSeats: 0 }),
  ];
  const h = renderHook(useLobby, "four-reversi" as const);
  clock.advance(0);
  requests[0]!.respond(first);
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).toContain("cursor=0%3A1%3A12345");
  expect(h.current.rooms).toHaveLength(0);
  expect(h.current.totalCount).toBe(0);
  expect(h.current.loading).toBe(true);
  expect(h.current.hasData).toBe(false);
  requests[1]!.respond({ rooms: doubles, nextCursor: null, totalCount: 24 });
  await flush();
  expect(h.current.rooms).toHaveLength(22);
  expect(h.current.totalCount).toBe(22);
  expect(h.current.hasData).toBe(true);
  const count = requests.length;
  act(() => {
    h.current.changeMode("doubles");
    h.current.changeJoinable(true);
  });
  expect(h.current.rooms.map((room) => room.id)).toEqual(["23456"]);
  expect(h.current.totalCount).toBe(1);
  expect(h.current.loading).toBe(false);
  expect(requests).toHaveLength(count);

  act(() => void h.current.refresh());
  requests[2]!.respond({
    ...first,
    rooms: [lobbyCard("23456", { mode: "doubles", hostName: "途中の更新" })],
  });
  await flush();
  expect(h.current.rooms[0]!.hostName).toBe("ホスト");
  requests[3]!.respond({ message: "更新できませんでした" }, 503);
  await flush();
  expect(h.current.rooms[0]!.hostName).toBe("ホスト");
  expect(h.current.totalCount).toBe(1);
  expect(h.current.hasData).toBe(true);
  expect(h.current.error).toBe("更新できませんでした");
  clock.advance(10_000);
  expect(requests[4]!.url).not.toContain("cursor=");
  requests[4]!.respond({ rooms: [lobbyCard("12345")], nextCursor: null, totalCount: 1 });
  await flush();
  expect(h.current.rooms).toHaveLength(0);
  expect(h.current.totalCount).toBe(0);
  expect(h.current.hasData).toBe(true);
  expect(h.current.error).toBeNull();
  act(() => h.current.changeMode("all"));
  expect(h.current.rooms).toHaveLength(1);
});
test("初回途中失敗では部分一覧を出さず、重複cursorを停止して再試行は先頭から行う", async () => {
  const h = renderHook(useLobby, "four-reversi" as const);
  clock.advance(0);
  requests[0]!.respond({ rooms: [lobbyCard("12345")], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  requests[1]!.respond({}, 503);
  await flush();
  expect(h.current.rooms).toHaveLength(0);
  expect(h.current.isInitialLoading).toBe(false);
  expect(h.current.hasData).toBe(false);
  expect(h.current.error).not.toBeNull();
  act(() => void h.current.refresh());
  expect(requests[2]!.url).not.toContain("cursor=");
  requests[2]!.respond({ rooms: [lobbyCard("12345")], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  requests[3]!.respond({ rooms: [lobbyCard("12346")], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  expect(requests).toHaveLength(4);
  expect(h.current.error).toBe("一覧を最後まで取得できませんでした。もう一度お試しください。");
  expect(h.current.rooms).toHaveLength(0);
  act(() => void h.current.refresh());
  requests[4]!.respond({ rooms: [lobbyCard("12345")], nextCursor: "0:1:12345", totalCount: 5 });
  await flush();
  requests[5]!.respond({
    rooms: [lobbyCard("12345", { hostName: "新しいホスト", updatedAtMs: 2 }), lobbyCard("12346")],
    nextCursor: null,
    totalCount: 2,
  });
  await flush();
  expect(h.current.rooms.map((room) => room.hostName)).toEqual(["新しいホスト", "ホスト"]);
  expect(h.current.totalCount).toBe(2);
  expect(h.current.error).toBeNull();
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
