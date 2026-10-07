import { expect, test } from "bun:test";
import { Link, MemoryRouter } from "react-router";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { PlayerProfileTrigger } from "../src/features/players/PlayerProfileTrigger";
import { PlayerProfileStore, profileKey } from "../src/features/players/playerProfileStore";
import { AppDialog } from "../src/shared/ui/AppDialog";
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
    target={target}
    localProfile={cpu ? { kind: "cpu", level: 2 } : undefined}
    game="four-reversi"
    mode="singles"
    label={label}
  >
    {label}
  </PlayerProfileTrigger>
);
const region = () => document.querySelector<HTMLElement>('[role="region"]');
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
test("cache expires at 60 seconds, deduplicates requests, preserves source aliases and rejects invalidated late completion", async () => {
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
  await store.load(target, "four-reversi");
  expect(requests).toHaveLength(3);
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
