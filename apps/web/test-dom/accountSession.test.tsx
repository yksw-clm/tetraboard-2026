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
  requests[0]!.respond({ user: profile });
  await flush();
  expect(account.user).toEqual(profile);
  act(() => window.dispatchEvent(new Event("focus")));
  requests[1]!.respond({}, 503);
  await flush();
  expect(account.user).toEqual(profile);
  expect(account.error).not.toBeNull();
  act(() => window.dispatchEvent(new Event("focus")));
  act(() => window.dispatchEvent(new Event("focus")));
  requests[3]!.respond({ user: null });
  await flush();
  requests[2]!.respond({ user: profile });
  await flush();
  expect(account.user).toBeNull();
  expect(account.error).toBeNull();
});

test("アカウントメニューはプロフィール・マイページとログアウトを扱い、失敗後再試行できる", async () => {
  function Path() {
    return <p data-testid="current-path">{useLocation().pathname}</p>;
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
  open();
  await flush();
  choose("ログアウト");
  await flush();
  expect(requests.at(-1)!.url).toBe("/api/auth/sign-out");
  expect(
    view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.disabled,
  ).toBe(true);
  requests.at(-1)!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  const replace = spyOn(window.location, "replace").mockImplementation(() => {});
  try {
    saveRegistrationReturn({ path: "/games/four-shogi" }, false);
    open();
    await flush();
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

test("未完了プロフィールは初回設定へ誘導し、受付・公開棋譜は妨げない", async () => {
  for (const path of ["/games/four-shogi", "/feedback", "/matches/example"]) {
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
