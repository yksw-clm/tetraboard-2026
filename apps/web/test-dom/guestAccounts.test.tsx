import { expect, test } from "bun:test";
import { RoomIdentityFields } from "../src/features/account/RoomIdentityFields";
import { AccountMenu } from "../src/features/account/AccountMenu";
import {
  GuestAccountControls,
  GuestMergeConfirmation,
} from "../src/features/account/GuestAccountControls";
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
test("ゲストの名前変更は専用APIで保存し、失敗時も下書きと記録の連携案内を保持する", async () => {
  const view = render(wrap(guestProfile())(<GuestAccountControls />));
  enter(view.querySelector("input")!, "変更名");
  press(view, "名前を保存");
  await flush();
  expect(requests[0]!.url).toBe("/api/account/guest/name");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ name: "変更名" });
  requests[0]!.respond({ message: "保存できません" }, 503);
  await flush();
  expect(view.querySelector<HTMLInputElement>("input")!.value).toBe("変更名");
  expect(view.textContent).toContain("保存できません");
  expect(view.textContent).toContain("全ゲームの記録");
  expect(view.textContent).toContain("Cookie");
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
