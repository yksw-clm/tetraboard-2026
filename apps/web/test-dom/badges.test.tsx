import { expect, test } from "bun:test";
import { type AccountStats as Stats, type PlayerProfile } from "@tetraboard/protocol";
import { AccountStats } from "../src/features/account/AccountStats";
import { AccountBadges } from "../src/features/badges/AccountBadges";
import { PlayerProfileCard } from "../src/features/players/PlayerProfileCard";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { PlayerProfileTrigger } from "../src/features/players/PlayerProfileTrigger";
import { MemoryRouter } from "react-router";
import {
  emptyProfileState,
  PlayerProfileStore,
  profileKey,
} from "../src/features/players/playerProfileStore";
import { act, clock, flush, press, render, rerender, requests } from "./harness";

const target = { source: "profile" as const, profileId: "10000000-0000-4000-8000-000000000001" };
const initial: Stats = {
  singles: { total: 4, first: 2, second: 2, third: 0, fourth: 0 },
  doubles: { total: 100, wins: 100, losses: 0, draws: 0 },
};
const shogi: Stats = {
  singles: {
    total: 100,
    first: 50,
    second: 50,
    third: 0,
    fourth: 0,
    knockouts: 60,
    perfectWins: 3,
  },
  doubles: initial.doubles,
};
const profile: PlayerProfile = {
  kind: "account",
  profileId: target.profileId,
  name: "登録者",
  username: "registered",
  avatarUrl: null,
  game: "four-shogi",
  stats: { singles: { total: 100, first: 50 }, doubles: { total: 100, wins: 100 } },
  badges: [
    { id: "knockouts", tier: 3, value: 60 },
    { id: "games", tier: 3, value: 100 },
  ],
};
const badgeSection = (view: HTMLElement) =>
  view.querySelector('[aria-labelledby="account-badges-title"]');

test("account shows all targets, highest tiers and exact large live numbers", () => {
  const view = render(<AccountBadges game="four-reversi" stats={initial} />);
  expect(view.querySelectorAll("img")).toHaveLength(2);
  expect(view.textContent?.match(/未獲得/g)).toHaveLength(2);
  expect(view.textContent).toContain("4局 / 5局");
  expect(view.textContent).toContain("3回 / 15回 / 50回");
  rerender(view, <AccountBadges game="four-shogi" stats={shogi} />);
  expect(view.querySelectorAll("img")).toHaveLength(4);
  expect(view.innerHTML).toContain("knockouts-star-3.webp");
  expect(view.textContent).toContain("60人");
  const large = {
    ...shogi,
    singles: { ...shogi.singles, total: 123456789012345, first: 123456789012345, second: 0 },
  };
  rerender(view, <AccountBadges game="four-shogi" stats={large} />);
  expect(view.textContent).toContain("123456789012345");
  expect(view.textContent).not.toContain("123K");
});

test("account shares requests, switches mode/game, and retains badges when refresh fails", async () => {
  const view = render(<AccountStats game="four-reversi" mode="singles" />);
  clock.advance(0);
  expect(requests).toHaveLength(1);
  requests[0]!.respond({}, 503);
  await flush();
  expect(badgeSection(view)).toBeNull();
  expect(view.textContent).not.toContain("未獲得");
  press(view, "再試行");
  requests[1]!.respond(initial);
  await flush();
  expect(badgeSection(view)).not.toBeNull();
  rerender(view, <AccountStats game="four-reversi" mode="doubles" />);
  await flush();
  expect(badgeSection(view)).toBeNull();
  expect(requests).toHaveLength(2);
  rerender(view, <AccountStats game="four-reversi" mode="singles" />);
  press(view, "更新");
  requests[2]!.respond({ ...initial, singles: { ...initial.singles, total: 5, second: 3 } });
  await flush();
  expect(badgeSection(view)?.textContent).toContain("星1");
  press(view, "更新");
  requests[3]!.respond({}, 503);
  await flush();
  expect(badgeSection(view)?.textContent).toContain("5局 / 20局");
  rerender(view, <AccountStats game="four-shogi" mode="singles" />);
  clock.advance(0);
  expect(badgeSection(view)).toBeNull();
  requests.find((entry) => entry.url === "/api/account/stats?game=four-shogi")!.respond(shogi);
  await flush();
  expect(badgeSection(view)?.querySelectorAll("img")).toHaveLength(4);
  rerender(view, <AccountStats game="four-reversi" mode="singles" />);
  expect(badgeSection(view)?.querySelectorAll("img")).toHaveLength(2);
});

test("profile shows earned badges in catalog order only in singles, with accessible conditions", () => {
  const card = (current: PlayerProfile, mode: "singles" | "doubles" = "singles") => (
    <PlayerProfileCard
      game="four-shogi"
      mode={mode}
      state={emptyProfileState}
      localProfile={current}
      onRetry={() => {}}
    />
  );
  const view = render(card(profile));
  const section = view.querySelector('[aria-label="獲得済みバッジ"]')!;
  expect(section.querySelectorAll("img")).toHaveLength(2);
  expect(section.querySelector("img")?.getAttribute("src")).toContain("games-star-3");
  expect(section.querySelector('[aria-label*="撃破数・星3・60人"]')).not.toBeNull();
  act(() => (section.querySelector("summary") as HTMLElement).click());
  expect(section.querySelector("details")?.open).toBe(true);
  expect(section.textContent).toContain("相手を詰ませて撃破する");
  rerender(view, card(profile, "doubles"));
  expect(view.querySelector('[aria-label="獲得済みバッジ"]')).toBeNull();
  if (profile.kind !== "account") throw new Error("Account expected");
  for (const badges of [[], undefined]) {
    rerender(view, card({ ...profile, badges }));
    expect(view.querySelector('[aria-label="獲得済みバッジ"]')).toBeNull();
  }
  rerender(view, card({ kind: "guest", name: "ゲスト", avatarUrl: null }));
  expect(view.querySelector('[aria-label="獲得済みバッジ"]')).toBeNull();
});

test("profile opt-in falls back once on old Worker and does not fabricate badges", async () => {
  const store = new PlayerProfileStore();
  const pending = store.load(target, "four-shogi");
  expect(requests[0]!.url).toContain("includeBadges=1");
  requests[0]!.respond({}, 400);
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url).not.toContain("includeBadges");
  const { badges: _badges, ...legacy } = profile;
  requests[1]!.respond(legacy);
  await pending;
  expect(store.get(profileKey(target, "four-shogi")).profile).toEqual(legacy);
  const update = store.load(target, "four-shogi", true);
  requests[2]!.respond(profile);
  await update;
  expect(store.get(profileKey(target, "four-shogi")).profile).toEqual(profile);
  const failed = store.load(target, "four-shogi", true);
  requests[3]!.respond({}, 400);
  await flush();
  requests[4]!.respond({}, 400);
  await failed;
  expect(requests).toHaveLength(5);
  expect(store.get(profileKey(target, "four-shogi")).error).not.toBeNull();
});

test("expanded conditions and card scrolling keep the preview open; Escape restores its trigger", () => {
  const view = render(
    <MemoryRouter>
      <PlayerProfileProvider>
        <PlayerProfileTrigger
          localProfile={profile}
          game="four-shogi"
          mode="singles"
          label="登録者"
        >
          登録者
        </PlayerProfileTrigger>
      </PlayerProfileProvider>
    </MemoryRouter>,
  );
  const trigger = view.querySelector<HTMLButtonElement>(
    'button[aria-label="登録者のプレイヤー情報"]',
  )!;
  act(() => trigger.click());
  const region = document.querySelector<HTMLElement>(
    'section[aria-label="登録者のプレイヤー情報"]',
  )!;
  const summary = region.querySelector("summary")!;
  act(() => summary.click());
  expect(region.querySelector("details")?.open).toBe(true);
  act(() => region.dispatchEvent(new Event("scroll")));
  expect(document.querySelector('section[aria-label="登録者のプレイヤー情報"]')).not.toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('section[aria-label="登録者のプレイヤー情報"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
