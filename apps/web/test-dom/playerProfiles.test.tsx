import { expect, test } from "bun:test";
import { Link, MemoryRouter } from "react-router";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { PlayerProfileTrigger } from "../src/features/players/PlayerProfileTrigger";
import { PlayerProfileCard } from "../src/features/players/PlayerProfileCard";
import type { PlayerProfile } from "@tetraboard/protocol";
import { PlayerProfileStore, profileKey } from "../src/features/players/playerProfileStore";
import { AppDialog } from "../src/shared/ui/AppDialog";
import { PlayerCardView } from "../src/features/room/PlayerCardView";
import { PlayerAvatar } from "../src/features/room/PlayerAvatar";
import { act, clock, flush, render, rerender, requests } from "./harness";
const id = "10000000-0000-4000-8000-000000000001";
const target = { source: "profile" as const, profileId: id };
const profile = {
  kind: "account",
  profileId: id,
  game: "four-reversi",
  name: "現在名",
  username: "current_id",
  avatarUrl: null,
  stats: { singles: { total: 3, first: 1 }, doubles: { total: 4, wins: 2 } },
};
const wrap = (child: React.ReactNode) => (
  <MemoryRouter>
    <PlayerProfileProvider>{child}</PlayerProfileProvider>
  </MemoryRouter>
);
const trigger = (label = "プレイヤー", cpu = false) => (
  <PlayerProfileTrigger
    target={cpu ? undefined : target}
    localProfile={cpu ? { kind: "cpu", level: 2 } : undefined}
    game="four-reversi"
    mode="singles"
    label={label}
  >
    {label}
  </PlayerProfileTrigger>
);
const region = () => document.querySelector<HTMLElement>('[role="region"]');
test("プレイヤー情報に現在レートを表示し、元のトリガーの名前は維持する", async () => {
  const view = render(wrap(trigger()));
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  requests[0]!.respond({
    ...profile,
    rating: { timing: "current", status: "rated", rating: 1550.4, humanPlayed: false },
  });
  await flush();
  expect(region()?.textContent).toContain("現在のレート 1550");
  expect(region()?.textContent).toContain("対人戦未経験");
  expect(view.querySelector("button")?.textContent).toBe("プレイヤー");
});

test.each([
  { timing: "before", status: "rated", rating: 1549.6, text: "対局前レート 1550" },
  { timing: "before", status: "placement", text: "対局前レート 認定中" },
  { timing: "before", status: "unavailable", text: "対局前レート 記録なし" },
  { timing: "reference", status: "rated", rating: 1552, text: "基準レート 1552" },
  { timing: "current", status: "placement", text: "現在のレート 認定中" },
] as const)("レートの時点と公開状態を区別する（$text）", ({ text, ...rating }) => {
  const current: PlayerProfile = {
    ...profile,
    kind: "account",
    game: "four-reversi",
    rating,
  };
  const view = render(
    <PlayerProfileCard
      state={{ loading: false, error: null, loadedAt: 0, profile: current }}
      game="four-reversi"
      mode="singles"
      onRetry={() => {}}
    />,
  );
  expect(view.textContent).toContain(text);
  expect(view.textContent).not.toContain("ランク");
});

test("CPUの基準レートは対象対局から取得し、失敗は再試行できる", async () => {
  const matchTarget = { source: "match" as const, matchId: id, playerId: id };
  const view = render(
    wrap(
      <PlayerProfileTrigger
        target={matchTarget}
        localProfile={{ kind: "cpu", name: "ギン", level: 2 }}
        game="shogi"
        mode="singles"
        label="ギン"
      >
        ギン
      </PlayerProfileTrigger>,
    ),
  );
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(region()?.textContent).toContain("ギン");
  requests[0]!.respond({ message: "失敗" }, 503);
  await flush();
  expect(region()?.textContent).toContain("再試行");
  expect(region()?.textContent).not.toContain("認定中");
  act(() => region()!.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click());
  await flush();
  requests[1]!.respond({
    kind: "cpu",
    name: "ギン",
    level: 2,
    rating: { timing: "reference", status: "rated", rating: 1552 },
  });
  await flush();
  expect(region()?.textContent).toContain("基準レート 1552");
});

test("同じ人の別対局・現在値・通常対局をキャッシュで混同しない", async () => {
  const store = new PlayerProfileStore();
  const firstMatch = { source: "match" as const, matchId: id, playerId: id };
  const secondMatch = { ...firstMatch, matchId: "20000000-0000-4000-8000-000000000002" };
  const normalRoom = { source: "room" as const, roomId: "12345", instanceId: id, playerId: id };
  const cases = [
    { source: target, rating: { timing: "current", status: "rated", rating: 1600 } },
    { source: firstMatch, rating: { timing: "before", status: "rated", rating: 1400 } },
    { source: secondMatch, rating: { timing: "before", status: "placement" } },
    { source: normalRoom, rating: undefined },
  ] as const;
  for (const [index, entry] of cases.entries()) {
    const loading = store.load(entry.source, "four-reversi");
    requests[index]!.respond({ ...profile, ...(entry.rating ? { rating: entry.rating } : {}) });
    await loading;
  }
  for (const entry of cases) {
    await store.load(entry.source, "four-reversi");
    const saved = store.get(profileKey(entry.source, "four-reversi")).profile;
    expect(saved?.kind === "account" ? saved.rating : undefined).toEqual(entry.rating);
  }
  expect(requests).toHaveLength(4);
});

test("固有名CPUはロボット・CPU表記を併用し、互換用レベルでなく実際のLv3と判断方法を表示する", async () => {
  const cpuProfile = {
    id: "lv3-v1" as const,
    engineVersion: "0.2.0",
    rulesetVersion: "four-reversi-singles-v2" as const,
    stateVersion: 2 as const,
    hash: "a".repeat(64),
    agentId: "maxn-v1",
    level: 3,
    name: "ヨミ",
    style: "多人数の先読み",
  };
  const player = {
    id: crypto.randomUUID(),
    name: "ヨミ1",
    kind: "cpu" as const,
    level: 2 as const,
    ready: true as const,
    color: null,
    reconnectDeadline: null,
    cpuProfile,
  };
  const view = render(
    wrap(
      <PlayerCardView
        player={player}
        self={false}
        host={false}
        position="bottom"
        score={null}
        rank={null}
        clock={null}
      />,
    ),
  );
  expect(view.querySelector('[data-testid="player-name"]')?.textContent).toContain("ヨミ1CPU");
  const avatar = view.querySelector('[data-testid="player-avatar"]');
  expect(avatar?.getAttribute("title")).toBe("CPU");
  const robot = render(<PlayerAvatar appearance={{ kind: "cpu", level: 2 }} />);
  expect(avatar?.querySelector("svg")?.innerHTML).toBe(robot.querySelector("svg")?.innerHTML);
  expect(avatar?.querySelector("svg")).not.toBeNull();
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="ヨミ1のプレイヤー情報"]')!.click());
  await flush();
  expect(region()?.textContent).toContain("ヨミ1");
  expect(region()?.textContent).toContain("CPU Lv3");
  expect(region()?.textContent).toContain("多人数の先読み");
  expect(region()?.textContent).not.toContain("CPU Lv2");
  expect(requests).toHaveLength(0);
});
test.each([
  { stored: "シテン2", shown: "シテン2", card: "シテン2CPU" },
  { stored: "CPU（標準）", shown: "CPU Lv2", card: "CPU Lv2" },
  { stored: "CPU 1", shown: "CPU Lv2", card: "CPU Lv2" },
])(
  "四人将棋のCPUはルームとプレイヤー情報に同じ名前が出る（$stored）",
  async ({ stored, shown, card }) => {
    const cpu = {
      id: crypto.randomUUID(),
      name: stored,
      kind: "cpu" as const,
      level: 2 as const,
      ready: true as const,
      side: null,
      reconnectDeadline: null,
    };
    const view = render(
      wrap(
        <PlayerCardView
          player={cpu}
          self={false}
          host={false}
          position="bottom"
          score={null}
          rank={null}
          clock={null}
          game="four-shogi"
        />,
      ),
    );
    expect(view.querySelector('[data-testid="player-name"]')?.textContent).toBe(card);
    expect(view.querySelector('[data-testid="player-avatar"] svg')).not.toBeNull();
    act(() =>
      view.querySelector<HTMLButtonElement>(`[aria-label="${shown}のプレイヤー情報"]`)!.click(),
    );
    await flush();
    expect(region()?.textContent).toContain(shown);
    expect(requests).toHaveLength(0);
  },
);
test("全ゲームの戦績をモードに応じたコンパクトな文章で表示する", () => {
  const singles = { total: 83, first: 22, second: 36, third: 17, fourth: 8 };
  const shogiSingles = { ...singles, knockouts: 51, perfectWins: 2 };
  const doubles = { total: 20, wins: 12, losses: 7, draws: 1 };
  for (const game of [
    "four-reversi",
    "four-gomoku",
    "four-shogi",
    "reversi",
    "shogi",
    "gomoku",
  ] as const) {
    const current: PlayerProfile = {
      ...profile,
      kind: "account",
      game,
      stats: game.startsWith("four-")
        ? {
            singles: game === "four-shogi" ? shogiSingles : singles,
            doubles,
          }
        : doubles,
    };
    for (const mode of ["singles", "doubles"] as const) {
      const view = render(
        <PlayerProfileCard
          state={{ loading: false, profile: current, error: null, loadedAt: 0 }}
          game={game}
          mode={mode}
          onRetry={() => {}}
        />,
      );
      const summary = [...view.querySelectorAll("p")].find(
        (node) => node.textContent?.startsWith("83局") || node.textContent?.startsWith("20局"),
      )!;
      expect(summary.textContent).toBe(
        game.startsWith("four-") && mode === "singles"
          ? `83局 22優勝 (.265) 平均2.13位${game === "four-shogi" ? " 51撃破" : ""}`
          : "20局 12勝7敗1分 (.600)",
      );
      expect(view.querySelector("dl")).toBeNull();
    }
  }
});
test("dismissal cancels another trigger's pending hover until its pointer leaves", async () => {
  const view = render(
    wrap(
      <>
        {trigger("アイコン")}
        {trigger("名前")}
      </>,
    ),
  );
  const [icon, name] = [...view.querySelectorAll<HTMLButtonElement>("button")];
  act(() => icon!.click());
  await flush();
  requests[0]!.respond(profile);
  await flush();
  act(() =>
    name!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(100);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  clock.advance(500);
  await flush();
  expect(Boolean(region())).toBe(false);
  act(() => {
    name!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    name!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  });
  clock.advance(300);
  await flush();
  expect(Boolean(region())).toBe(true);
});
test("outside dismissal stays closed when Popover restores trigger focus, then a new focus can reopen", async () => {
  const view = render(
    wrap(
      <>
        {trigger()}
        <h1>カード外</h1>
        <button>別の操作</button>
      </>,
    ),
  );
  const button = view.querySelector<HTMLButtonElement>(
    '[aria-label="プレイヤーのプレイヤー情報"]',
  )!;
  act(() => {
    button.focus();
    button.click();
  });
  await flush();
  requests[0]!.respond(profile);
  await flush();
  const outside = view.querySelector("h1")!;
  act(() => {
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  // FocusScope may restore focus asynchronously when an outside heading is not focusable.
  act(() => button.focus());
  act(() => button.blur());
  act(() => button.focus());
  clock.advance(500);
  await flush();
  expect(Boolean(region())).toBe(false);
  act(() => view.querySelector<HTMLButtonElement>("button:last-child")!.focus());
  act(() => button.focus());
  await flush();
  expect(Boolean(region())).toBe(true);
  act(() => button.click());
  await flush();
  act(() => document.dispatchEvent(new Event("scroll")));
  await flush();
  act(() => button.focus());
  clock.advance(500);
  expect(Boolean(region())).toBe(false);
});
test("cache expires at 60 seconds, deduplicates requests, separates match context and rejects invalidated late completion", async () => {
  const store = new PlayerProfileStore();
  const first = store.load(target, "four-reversi");
  const second = store.load(target, "four-reversi");
  expect(requests).toHaveLength(1);
  requests[0]!.respond(profile);
  await first;
  await second;
  clock.advance(59_999);
  await store.load(target, "four-reversi");
  expect(requests).toHaveLength(1);
  clock.advance(1);
  const update = store.load(target, "four-reversi");
  expect(requests).toHaveLength(2);
  store.invalidate({ profileId: id });
  requests[1]!.respond({ ...profile, name: "古い応答" });
  await update;
  expect(store.get(profileKey(target, "four-reversi")).profile).toBeNull();
  const source = { source: "match" as const, matchId: id, playerId: id };
  const fromMatch = store.load(source, "four-reversi");
  requests[2]!.respond(profile);
  await fromMatch;
  const current = store.load(target, "four-reversi");
  expect(requests).toHaveLength(4);
  requests[3]!.respond(profile);
  await current;
  store.invalidate({ game: "four-shogi" });
  expect(store.get(profileKey(source, "four-reversi")).profile).not.toBeNull();
  store.clear();
  expect(store.get(profileKey(source, "four-reversi")).profile).toBeNull();
});
test("hover waits 300ms, permits moving into the card, closes after 150ms and Escape suppresses reopening", async () => {
  const view = render(wrap(trigger()));
  const button = view.querySelector("button")!;
  act(() =>
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(299);
  expect(requests).toHaveLength(0);
  clock.advance(1);
  await flush();
  expect(requests).toHaveLength(1);
  requests[0]!.respond(profile);
  await flush();
  expect(region()?.textContent).toContain(".333");
  expect(document.activeElement === region()).toBe(false);
  act(() => {
    button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    region()!.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    );
  });
  clock.advance(150);
  expect(Boolean(region())).toBe(true);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  clock.advance(500);
  expect(Boolean(region())).toBe(false);
  act(() =>
    button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })),
  );
  act(() =>
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(300);
  await flush();
  expect(Boolean(region())).toBe(true);
  act(() =>
    button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(149);
  expect(Boolean(region())).toBe(true);
  clock.advance(1);
  await flush();
  expect(Boolean(region())).toBe(false);
});
test("explicit activation focuses the card, retry keeps Escape available and closes only the nested preview", async () => {
  let outerClosed = 0;
  const view = render(
    wrap(
      <AppDialog
        title="ランキング"
        onClose={() => {
          outerClosed++;
        }}
      >
        {trigger()}
      </AppDialog>,
    ),
  );
  const button = document.querySelector<HTMLButtonElement>(
    '[aria-label="プレイヤーのプレイヤー情報"]',
  )!;
  act(() => button.click());
  await flush();
  expect(Boolean(region())).toBe(true);
  expect(region()!.closest('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement === region()).toBe(true);
  requests[0]!.respond({}, 503);
  await flush();
  const retry = [...region()!.querySelectorAll("button")].find((b) => b.textContent === "再試行")!;
  act(() => {
    retry.focus();
    retry.click();
  });
  await flush();
  expect(requests).toHaveLength(2);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  expect(outerClosed).toBe(0);
  expect(Boolean(region())).toBe(false);
  expect(document.activeElement === button).toBe(true);
  requests[1]!.respond(profile);
  await flush();
  expect(Boolean(region())).toBe(false);
  expect(view.isConnected).toBe(true);
  act(() => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  expect(outerClosed).toBe(1);
});
test("one preview is open and CPU needs no request", async () => {
  const view = render(
    wrap(
      <>
        {trigger("CPU", true)}
        {trigger("登録者")}
      </>,
    ),
  );
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="CPUのプレイヤー情報"]')!.click());
  await flush();
  expect(region()?.textContent).toContain("CPU Lv2");
  expect(requests).toHaveLength(0);
  const cpu = view.querySelector<HTMLButtonElement>('[aria-label="CPUのプレイヤー情報"]')!;
  const account = view.querySelector<HTMLButtonElement>('[aria-label="登録者のプレイヤー情報"]')!;
  for (const button of [cpu, account]) {
    act(() =>
      button.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
      ),
    );
    clock.advance(300);
    await flush();
    act(() =>
      button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })),
    );
    clock.advance(150);
    await flush();
    expect(region()?.textContent).toContain("CPU Lv2");
    expect(requests).toHaveLength(0);
  }
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="登録者のプレイヤー情報"]')!.click(),
  );
  await flush();
  expect(document.querySelectorAll('[role="region"]')).toHaveLength(1);
  expect(requests).toHaveLength(1);
});
test("mode changes and navigation close the preview; navigation cancels pending data", async () => {
  const page = (mode: "singles" | "doubles") =>
    wrap(
      <>
        <PlayerProfileTrigger target={target} game="four-reversi" mode={mode} label="本人">
          本人
        </PlayerProfileTrigger>
        <Link to="/other">移動</Link>
      </>,
    );
  const view = render(page("singles"));
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  requests[0]!.respond(profile);
  await flush();
  rerender(view, page("doubles"));
  await flush();
  expect(Boolean(region())).toBe(false);
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(region()?.textContent).toContain(".500");
  act(() => view.querySelector<HTMLAnchorElement>("a")!.click());
  await flush();
  expect(Boolean(region())).toBe(false);
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(requests).toHaveLength(2);
  act(() => view.querySelector<HTMLAnchorElement>("a")!.click());
  await flush();
  requests[1]!.respond({ ...profile, name: "遅い応答" });
  await flush();
  expect(Boolean(region())).toBe(false);
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(requests).toHaveLength(3);
});
test("focus opens immediately, background scroll closes and missing target is not labeled guest", async () => {
  const view = render(
    wrap(
      <PlayerProfileTrigger game="four-shogi" mode="doubles" label="旧応答">
        旧応答
      </PlayerProfileTrigger>,
    ),
  );
  act(() => view.querySelector("button")!.focus());
  await flush();
  expect(region()?.textContent).toContain("準備中");
  expect(region()?.textContent).not.toContain("ゲスト");
  expect(requests).toHaveLength(0);
  act(() => document.dispatchEvent(new Event("scroll")));
  await flush();
  expect(Boolean(region())).toBe(false);
});
