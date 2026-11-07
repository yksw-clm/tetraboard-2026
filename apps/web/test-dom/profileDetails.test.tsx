import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ProfileForm } from "../src/features/account/ProfileForm";
import { ProfilePage } from "../src/features/account/AccountPages";
import { AccountLayout } from "../src/features/account/AccountSession";
import { PlayerProfileCard } from "../src/features/players/PlayerProfileCard";
import { PlayerProfileStore } from "../src/features/players/playerProfileStore";
import { profile } from "../test/fixtures/account";
import { act, enter, flush, press, render, requests, wrap } from "./harness";

test("ひとことと3ゲームを編集し、保存失敗後も保持して再試行できる", async () => {
  const user = { ...profile, profileMessage: "よろしく", favoriteGames: ["shogi" as const] };
  const saved: unknown[] = [];
  const view = render(
    wrap(user)(<ProfileForm user={user} setup={false} onSaved={(value) => saved.push(value)} />),
  );
  const input = view.querySelector<HTMLInputElement>('input[name="profileMessage"]')!;
  expect(input).not.toBeNull();
  expect(input.value).toBe("よろしく");
  enter(input, "あ".repeat(31));
  press(view, "保存");
  expect(requests).toHaveLength(0);
  expect(view.textContent).toContain("ひとことは改行なしの30文字以内で入力してください。");
  enter(input, "👨‍👩‍👧‍👦".repeat(30));
  expect(view.textContent).toContain("30 / 30文字");
  const games = view.querySelector<HTMLElement>('[aria-label="お気に入りゲームの選択"]')!;
  press(games, "四人将棋");
  press(games, "五目並べ");
  expect(games.querySelectorAll('[aria-pressed="true"]')).toHaveLength(3);
  expect(
    [...games.querySelectorAll<HTMLButtonElement>('[aria-pressed="false"]')].every(
      (b) => b.disabled,
    ),
  ).toBe(true);
  press(games, "将棋");
  expect([...games.querySelectorAll<HTMLButtonElement>("button")].every((b) => !b.disabled)).toBe(
    true,
  );
  press(games, "将棋");
  press(view, "保存");
  const data = requests[0]!.init.body as FormData;
  expect(data.get("profileMessage")).toBe("👨‍👩‍👧‍👦".repeat(30));
  expect(JSON.parse(String(data.get("favoriteGames")))).toEqual(["four-shogi", "shogi", "gomoku"]);
  expect(input.disabled).toBe(true);
  expect([...games.querySelectorAll<HTMLButtonElement>("button")].every((b) => b.disabled)).toBe(
    true,
  );
  requests[0]!.respond({ message: "保存失敗" }, 503);
  await flush();
  expect(input.value).toBe("👨‍👩‍👧‍👦".repeat(30));
  expect(games.querySelectorAll('[aria-pressed="true"]')).toHaveLength(3);
  press(view, "保存");
  requests[1]!.respond({
    ...user,
    profileMessage: input.value,
    favoriteGames: ["four-shogi", "shogi", "gomoku"],
  });
  await flush();
  expect(saved).toHaveLength(1);
});

test("マイページで保存内容を表示し、取消で破棄、保存と明示的な削除を反映する", async () => {
  const user = { ...profile, profileMessage: "遊ぼう", favoriteGames: ["gomoku" as const] };
  const router = createMemoryRouter(
    [{ element: <AccountLayout />, children: [{ path: "/account", element: <ProfilePage /> }] }],
    { initialEntries: ["/account"] },
  );
  const view = render(<RouterProvider router={router} />);
  requests.find((r) => r.url === "/api/account/session")!.respond({ user });
  await flush();
  const card = () => view.querySelector<HTMLElement>('[data-testid="account-profile-card"]')!;
  expect(card().textContent).toContain("遊ぼう");
  expect(card().textContent).toContain("五目並べ");
  press(card(), "プロフィールを編集");
  await flush();
  enter(document.querySelector<HTMLInputElement>('input[name="profileMessage"]')!, "未保存");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  press(card(), "プロフィールを編集");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const input = dialog.querySelector<HTMLInputElement>('input[name="profileMessage"]')!;
  expect(input.value).toBe("遊ぼう");
  enter(input, "");
  press(dialog.querySelector<HTMLElement>('[aria-label="お気に入りゲームの選択"]')!, "五目並べ");
  press(dialog, "保存");
  const save = requests.find((r) => r.url === "/api/account/profile")!;
  const data = save.init.body as FormData;
  expect(data.get("profileMessage")).toBe("");
  expect(data.get("favoriteGames")).toBe("[]");
  save.respond({ ...user, profileMessage: "", favoriteGames: [] });
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(card().textContent).not.toContain("遊ぼう");
  expect(card().querySelector('[aria-label="お気に入りゲーム"]')).toBeNull();
});

test("公開カードは通常テキストとゲーム名を表示し、未設定項目は表示しない", async () => {
  const store = new PlayerProfileStore();
  const target = { source: "profile" as const, profileId: "10000000-0000-4000-8000-000000000001" };
  const pending = store.load(target, "four-reversi");
  expect(new URL(requests[0]!.url, "http://localhost").searchParams.get("includeDetails")).toBe(
    "1",
  );
  requests[0]!.respond({
    kind: "account",
    name: profile.name,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    profileId: target.profileId,
    game: "four-reversi",
    profileMessage: "<b>対局しよう</b>",
    favoriteGames: ["shogi"],
    stats: { singles: { total: 0, first: 0 }, doubles: { total: 0, wins: 0 } },
  });
  await pending;
  const state = store.get(JSON.stringify(["four-reversi", target]));
  const view = render(
    <PlayerProfileCard state={state} game="four-reversi" mode="singles" onRetry={() => {}} />,
  );
  expect(view.querySelector('[aria-label="ひとこと"]')!.textContent).toContain("<b>対局しよう</b>");
  expect(view.querySelector("b")).toBeNull();
  expect(view.querySelector('[aria-label="お気に入りゲーム"]')!.textContent).toContain("将棋");
  const empty = render(
    <PlayerProfileCard
      state={{
        ...state,
        profile:
          state.profile?.kind === "account"
            ? { ...state.profile, profileMessage: "", favoriteGames: [] }
            : null,
      }}
      game="four-reversi"
      mode="singles"
      onRetry={() => {}}
    />,
  );
  expect(empty.querySelector('[aria-label="ひとこと"]')).toBeNull();
  expect(empty.querySelector('[aria-label="お気に入りゲーム"]')).toBeNull();
});
