import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RoomIdentityFields } from "../src/features/account/RoomIdentityFields";
import { AccountMenu } from "../src/features/account/AccountMenu";
import { ProfilePage } from "../src/features/account/AccountPages";
import { AccountLayout } from "../src/features/account/AccountSession";
import { GuestMergeConfirmation } from "../src/features/account/GuestAccountControls";
import { ensureGuestAccount } from "../src/features/account/guestAccount";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
import { act, enter, flush, press, render, renderHook, requests, wrap } from "./harness";

test("名前設定済みのゲストは再入力せず、未設定フラグなら自動名でも入力を求める", async () => {
  const user = guestProfile("ゲスト12345");
  render(wrap(user)(<RoomIdentityFields name="" onChange={() => {}} busy={false} />));
  expect(document.querySelector("input")).toBeNull();
  expect(document.querySelector('[aria-label="参加するアカウント"] p')?.textContent).toBe("ゲスト");
  render(
    wrap({ ...user, nameCustomized: false })(
      <RoomIdentityFields name="候補" onChange={() => {}} busy={false} />,
    ),
  );
  expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("候補");
  expect(requests).toHaveLength(0);
});
test("ゲストのアカウントメニューにはログアウト操作を表示しない", async () => {
  const view = render(wrap(guestProfile())(<AccountMenu />));
  expect(view.textContent).toContain(`@${guestProfile().username}`);
  act(() => view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.click());
  await flush();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.textContent).toContain("マイページ");
  expect(menu.textContent).not.toContain("ログアウト");
  expect(requests).toHaveLength(0);
});
test("ゲスト作成は同じ画面の並行操作で共有し、認証Cookieの読戻し後だけ参加可能にする", async () => {
  const first = ensureGuestAccount("参加者", null),
    second = ensureGuestAccount("参加者", null);
  expect(requests).toHaveLength(1);
  requests[0]!.respond({ user: null });
  await flush();
  expect(requests[1]!.url).toBe("/api/account/guest");
  requests[1]!.respond(guestProfile("参加者"), 201);
  await flush();
  expect(requests[2]!.url).toBe("/api/account/session");
  requests[2]!.respond({ user: guestProfile("参加者") });
  await expect(first).resolves.toMatchObject({ name: "参加者", isGuest: true });
  await expect(second).resolves.toMatchObject({ name: "参加者", isGuest: true });
  expect(requests).toHaveLength(3);
});
test("名前未入力・認証障害・Cookie拒否ではルーム作成を送らず、入力を保持する", async () => {
  const hook = renderHook(useRoomEntry, "four-reversi", wrap());
  act(() => hook.current.setName("参加者"));
  act(() => void hook.current.submitRoom("create"));
  requests[0]!.respond({ user: null });
  await flush();
  requests[1]!.respond({ user: null });
  await flush();
  requests[2]!.respond(guestProfile("参加者"), 201);
  await flush();
  requests[3]!.respond({ user: null });
  await flush();
  expect(hook.current.message).toContain("Cookie");
  expect(hook.current.name).toBe("参加者");
  expect(requests.some((r) => r.url === "/api/rooms")).toBe(false);
  const count = requests.length;
  act(() => void hook.current.submitRoom("create"));
  requests[count]!.reject(new Error("offline"));
  await flush();
  expect(requests).toHaveLength(count + 1);
  expect(hook.current.name).toBe("参加者");
});
test("ゲストは連携ボタンがあるマイページから共通ダイアログを開き、名前だけを変更できる", async () => {
  const router = createMemoryRouter(
    [
      {
        element: <AccountLayout />,
        children: [{ path: "/account", element: <ProfilePage /> }],
      },
    ],
    { initialEntries: ["/account"] },
  );
  const view = render(<RouterProvider router={router} />);
  const user = guestProfile();
  requests.find((request) => request.url === "/api/account/session")!.respond({ user });
  await flush();
  const card = view.querySelector('[data-testid="account-profile-card"]')!;
  expect(card.querySelector("input")).toBeNull();
  expect(card.textContent).toContain("Cookie");
  expect(card.textContent).toContain("Googleで続ける");
  expect(card.textContent).toContain("Discordで続ける");
  expect(card.textContent).not.toContain("IDは自動発行です");
  expect(card.textContent).not.toContain("連携すると、これまでの全ゲームの記録");

  const saves = () => requests.filter((request) => request.init.method === "PATCH");
  press(view, "プロフィールを編集");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("プロフィールを編集");
  expect(dialog.querySelector('[data-slot="avatar-fallback"] svg')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="アイコン画像を選択"]')).toBeNull();
  expect(dialog.querySelector('input[type="file"]')).toBeNull();
  const username = dialog.querySelector<HTMLInputElement>('input[name="username"]')!;
  expect(username.value).toBe(`@${user.username}`);
  expect(username.readOnly).toBe(true);
  expect(dialog.textContent).toContain(
    "画像アップロードとID変更には、GoogleまたはDiscordとの連携が必要です。",
  );
  const name = dialog.querySelector<HTMLInputElement>('input[name="name"]')!;
  expect(name.value).toBe(user.name);
  enter(name, " ");
  press(dialog, "保存");
  expect(dialog.textContent).toContain("名前は1〜10文字で入力してください。");
  expect(saves()).toHaveLength(0);

  enter(name, "変更名");
  press(dialog, "保存");
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.disabled).toBe(true);
  expect(saves()).toHaveLength(1);
  const request = saves()[0]!;
  expect(request.url).toBe("/api/account/guest/name");
  expect(JSON.parse(String(request.init.body))).toEqual({ name: "変更名" });
  request.respond({ message: "保存できません" }, 503);
  await flush();
  expect(name.value).toBe("変更名");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("保存できません");

  press(dialog, "保存");
  expect(saves()).toHaveLength(2);
  saves()[1]!.respond(guestProfile("変更名"));
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(card.querySelector("h1")?.textContent).toBe("変更名");
  expect(card.textContent).toContain(`@${user.username}`);
  expect(card.textContent).toContain("プロフィールを保存しました。");
  expect(view.querySelector('[aria-label="変更名のアカウントメニュー"]')).not.toBeNull();
});
test("既存登録者への引き継ぎは確認するまで送信せず、失敗時に再試行できる", async () => {
  render(wrap(profile, "/account?guestMerge=1")(<GuestMergeConfirmation />));
  await flush();
  expect(requests[0]!.url).toBe("/api/account/guest-merge");
  requests[0]!.respond({ pending: { guestName: "元のゲスト" } });
  await flush();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("元のゲスト");
  expect(requests).toHaveLength(1);
  press(document.body, "引き継ぐ");
  await flush();
  expect(requests[1]!.init.method).toBe("POST");
  requests[1]!.respond({ message: "同じ大会に参加しています" }, 409);
  await flush();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("同じ大会");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "記録は自動削除されません",
  );
  press(document.body, "引き継がずにログインする");
  await flush();
  expect(requests[2]!.init.method).toBe("DELETE");
  requests[2]!.respond({ cancelled: true });
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
