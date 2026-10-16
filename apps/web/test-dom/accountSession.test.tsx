// eslint-disable react/globals -- Test probes expose hook values to assertions.
import { expect, spyOn, test } from "bun:test";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { AccountLayout } from "../src/features/account/AccountSession";
import { RegistrationCompletion } from "../src/features/account/RegistrationCompletion";
import { useAccount } from "../src/features/account/useAccount";
import {
  saveRegistrationReturn,
  readRegistrationReturn,
} from "../src/features/account/registrationReturn";
import { profile } from "../test/fixtures/account";
import { AccountMenu } from "../src/features/account/AccountMenu";
import { act, flush, render, requests, wrap, rerender } from "./harness";

test("focusで認証を再確認し、失敗時にアカウントをゲストへ降格せず、遅い旧応答を破棄", async () => {
  const sessions = () => requests.filter((request) => request.url === "/api/account/session");
  let account!: ReturnType<typeof useAccount>;
  function Probe() {
    account = useAccount();
    return <span>{account.user?.name ?? "guest"}</span>;
  }
  render(
    <MemoryRouter initialEntries={["/games/four-reversi"]}>
      <Routes>
        <Route element={<AccountLayout />}>
          <Route path="*" element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(account.loading).toBe(true);
  sessions()[0]!.respond({ user: profile });
  await flush();
  expect(account.user).toEqual(profile);
  act(() => window.dispatchEvent(new Event("focus")));
  sessions()[1]!.respond({}, 503);
  await flush();
  expect(account.user).toEqual(profile);
  expect(account.error).not.toBeNull();
  act(() => window.dispatchEvent(new Event("focus")));
  act(() => window.dispatchEvent(new Event("focus")));
  sessions()[3]!.respond({ user: null });
  await flush();
  sessions()[2]!.respond({ user: profile });
  await flush();
  expect(account.user).toBeNull();
  expect(account.error).toBeNull();
});

test("アカウントメニューはプロフィール・マイページとログアウトを扱い、失敗後再試行できる", async () => {
  function Path() {
    const location = useLocation();
    return (
      <p data-testid="current-path" data-state={JSON.stringify(location.state)}>
        {location.pathname}
      </p>
    );
  }
  const view = render(
    wrap(profile)(
      <>
        <AccountMenu />
        <Path />
      </>,
    ),
  );
  expect(view.textContent).toContain(profile.username!);
  const open = () =>
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.click(),
    );
  const choose = (text: string) =>
    act(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes(text))!
        .click(),
    );
  open();
  await flush();
  expect(document.querySelector('[role="menu"]')!.textContent).toContain("マイページ");
  choose("マイページ");
  await flush();
  expect(view.querySelector('[data-testid="current-path"]')!.textContent).toBe("/account");
  expect(view.querySelector('[data-testid="current-path"]')!.getAttribute("data-state")).toBe(
    "null",
  );
  open();
  await flush();
  choose("ログアウト");
  await flush();
  expect(requests.at(-1)!.url).toBe("/api/auth/sign-out");
  const pendingLogout = document.querySelector<HTMLElement>(
    '[role="menuitem"][aria-label="ログアウト"]',
  )!;
  expect(pendingLogout.querySelector('[data-slot="pending-spinner"]')).not.toBeNull();
  expect(view.querySelector('[data-slot="pending-spinner"]')).toBeNull();
  const requestCount = requests.length;
  choose("ログアウト");
  expect(requests.length).toBe(requestCount);
  expect(
    view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.disabled,
  ).toBe(true);
  requests.at(-1)!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(pendingLogout.querySelector('[data-slot="pending-spinner"]')).toBeNull();
  const replace = spyOn(window.location, "replace").mockImplementation(() => {});
  try {
    saveRegistrationReturn({ path: "/games/four-shogi" }, false);
    choose("ログアウト");
    requests.at(-1)!.respond({}, 200);
    await flush();
    expect(readRegistrationReturn()).toBeNull();
    expect(replace).toHaveBeenCalledWith("/games/four-reversi");
  } finally {
    replace.mockRestore();
  }
  rerender(view, null);
  const guest = render(wrap(null, "/games/four-shogi")(<AccountMenu />));
  act(() => guest.querySelector<HTMLAnchorElement>('a[href="/login"]')!.click());
  expect(readRegistrationReturn()?.path).toBe("/games/four-shogi");
});

test("ロビーのアカウントメニューでも初回設定への遷移にはゲーム選択を追加しない", async () => {
  function Path() {
    const location = useLocation();
    return (
      <p data-testid="current-path" data-state={JSON.stringify(location.state)}>
        {location.pathname}
      </p>
    );
  }
  const view = render(
    wrap(
      { ...profile, profileCompleted: false },
      "/games/four-shogi",
    )(
      <>
        <AccountMenu lobbyGame="four-shogi" />
        <Path />
      </>,
    ),
  );
  act(() => view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.click());
  await flush();
  act(() =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes("マイページ"))!
      .click(),
  );
  await flush();
  expect(view.querySelector('[data-testid="current-path"]')!.textContent).toBe("/account/setup");
  expect(view.querySelector('[data-testid="current-path"]')!.getAttribute("data-state")).toBe(
    "null",
  );
});

test("未完了プロフィールは初回設定へ誘導し、受付・公開棋譜は妨げない", async () => {
  for (const path of ["/games/four-shogi", "/feedback", "/matches/example", "/tournaments/1"]) {
    let location!: ReturnType<typeof useLocation>;
    function Probe() {
      location = useLocation();
      return <p>{location.pathname}</p>;
    }
    const view = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AccountLayout />}>
            <Route path="*" element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    requests
      .at(-1)!
      .respond({ user: { ...profile, name: "", username: null, profileCompleted: false } });
    await flush();
    expect(location.pathname).toBe(path === "/games/four-shogi" ? "/account/setup" : path);
    rerender(view, null);
  }
});
test("OAuth完了は一度だけ復帰情報を消費し、ゲスト参加資格を変更せず自動参加しない", () => {
  sessionStorage.setItem("tetraboard:room:12345:membership", "a".repeat(64));
  const destination = {
    path: "/games/four-shogi",
    entry: { intent: "create" as const, name: "ゲスト", roomCode: "", mode: "singles" as const },
  };
  saveRegistrationReturn(destination, true);
  let location!: ReturnType<typeof useLocation>;
  function Probe() {
    location = useLocation();
    return null;
  }
  render(
    <MemoryRouter initialEntries={["/account"]}>
      <RegistrationCompletion enabled>
        <Probe />
      </RegistrationCompletion>
      <Probe />
    </MemoryRouter>,
  );
  expect(location.pathname).toBe(destination.path);
  expect(location.state.registrationReturn.entry).toEqual(destination.entry);
  expect(readRegistrationReturn()).toBeNull();
  expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBe("a".repeat(64));
  expect(requests).toHaveLength(0);
});

test("退会による接続失効の通知で本人を再確認し、古いプロフィール取得を破棄する", async () => {
  let account!: ReturnType<typeof useAccount>;
  function Probe() {
    account = useAccount();
    return <span>{account.user?.name ?? "guest"}</span>;
  }
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<AccountLayout />}>
          <Route path="*" element={<Probe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const sessions = () => requests.filter((r) => r.url === "/api/account/session");
  sessions()[0].respond({ user: profile });
  await flush();
  act(() => window.dispatchEvent(new Event("focus")));
  const stale = sessions().at(-1)!;
  act(() => window.dispatchEvent(new Event("tetraboard-account-privacy-check")));
  sessions().at(-1)!.respond({ user: null });
  await flush();
  expect(account.user).toBeNull();
  stale.respond({ user: profile });
  await flush();
  expect(account.user).toBeNull();
});
