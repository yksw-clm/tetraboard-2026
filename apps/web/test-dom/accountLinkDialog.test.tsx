import { expect, spyOn, test } from "bun:test";
import { useState } from "react";
import { ProfileForm } from "../src/features/account/ProfileForm";
import { AccountLinkDialog } from "../src/features/account/AccountLinkDialog";
import { AppDialog } from "../src/shared/ui/AppDialog";
import { avatarPresets, avatarPresetUrl } from "@tetraboard/protocol";
import { guestProfile } from "./guestAccountFixtures";
import { act, enter, flush, press, render, rerender, requests, wrap } from "./harness";

const user = {
  ...guestProfile(),
  avatarPresetId: avatarPresets[0].id,
  avatarUrl: avatarPresetUrl(avatarPresets[0].id),
};
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const linkDialog = () =>
  dialogs().find((dialog) => dialog.textContent?.includes("アカウントを連携しよう"))!;
function Editor({
  onClose = () => {},
  onSaved = () => {},
}: {
  onClose?: () => void;
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AppDialog title="プロフィールを編集" busy={busy} onClose={onClose}>
      <ProfileForm user={user} setup={false} onBusyChange={setBusy} onSaved={onSaved} />
    </AppDialog>
  );
}

test("ゲストにも全項目を表示し、制限機能は連携案内を重ね、Escapeで編集へ戻る", async () => {
  let closed = 0;
  render(wrap(user)(<Editor onClose={() => closed++} />));
  const editor = dialogs()[0]!;
  const message = editor.querySelector<HTMLInputElement>('input[name="profileMessage"]');
  expect(message).not.toBeNull();
  expect(message!.readOnly).toBe(true);
  const name = editor.querySelector<HTMLInputElement>('input[name="name"]')!;
  enter(name, "編集中の名前");
  const preset = avatarPresets[3];
  act(() => editor.querySelector<HTMLButtonElement>(`[aria-label="${preset.name}"]`)!.click());
  for (const [action, label] of [
    [() => message!.click(), "ひとこと"],
    [
      () => editor.querySelector<HTMLButtonElement>('[aria-label="アイコン画像を選択"]')!.click(),
      "画像",
    ],
    [
      () =>
        editor
          .querySelector<HTMLInputElement>('input[name="username"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      "ID",
    ],
    [
      () =>
        press(editor.querySelector<HTMLElement>('[aria-label="お気に入りゲームの選択"]')!, "将棋"),
      "お気に入り",
    ],
  ] as const) {
    act(() => {
      action();
    });
    await flush();
    expect(dialogs()).toHaveLength(2);
    expect(linkDialog().textContent).toContain(label);
    expect(linkDialog().textContent).toContain("Googleで続ける");
    expect(linkDialog().textContent).toContain("Discordで続ける");
    expect(requests).toHaveLength(0);
    act(() =>
      linkDialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(closed).toBe(0);
    expect(name.value).toBe("編集中の名前");
    expect(
      editor.querySelector(`[aria-label="${preset.name}"]`)!.getAttribute("aria-pressed"),
    ).toBe("true");
  }
});

test("連携前の名前エラーは保存もOAuthも送らず、同じボタンから再試行できる", async () => {
  render(wrap(user)(<Editor />));
  const editor = dialogs()[0]!;
  enter(editor.querySelector<HTMLInputElement>('input[name="name"]')!, " ");
  act(() => editor.querySelector<HTMLInputElement>('input[name="profileMessage"]')!.click());
  await flush();
  const dialog = linkDialog();
  press(dialog, "Googleで続ける");
  await flush();
  expect(requests).toHaveLength(0);
  expect(dialog.textContent).toContain("名前は1〜10文字で入力してから連携してください。");
  press(dialog, "Googleで続ける");
  await flush();
  expect(requests).toHaveLength(0);
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.disabled).toBe(false);
});

test("共通ダイアログは単独でも使え、閉じた後の古いOAuth応答では画面を遷移しない", async () => {
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    const view = render(wrap(user)(<AccountLinkDialog feature="フォロー" onClose={() => {}} />));
    expect(linkDialog().textContent).toContain("フォロー");
    press(linkDialog(), "Googleで続ける");
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/auth/sign-in/social");
    rerender(view, null);
    expect(requests[0]!.init.signal!.aborted).toBe(true);
    requests[0]!.respond({ url: "https://accounts.google.com/o/oauth2/auth" });
    await flush();
    expect(assign).not.toHaveBeenCalled();
  } finally {
    assign.mockRestore();
  }
});

test("編集画面が破棄されたら、連携前保存の古い応答からOAuthを開始しない", async () => {
  const view = render(wrap(user)(<Editor />));
  act(() => dialogs()[0]!.querySelector<HTMLInputElement>('input[name="profileMessage"]')!.click());
  await flush();
  press(linkDialog(), "Googleで続ける");
  expect(requests[0]!.url).toBe("/api/account/guest/name");
  rerender(view, null);
  requests[0]!.respond(user);
  await flush();
  expect(requests).toHaveLength(1);
  expect(dialogs()).toHaveLength(0);
});

test("保存して連携は名前・プリセットを先に保存し、保存失敗・OAuth開始失敗でも両画面を保持する", async () => {
  let saved = 0;
  render(wrap(user)(<Editor onSaved={() => saved++} />));
  const editor = dialogs()[0]!;
  enter(editor.querySelector<HTMLInputElement>('input[name="name"]')!, "新しい名前");
  act(() =>
    editor.querySelector<HTMLButtonElement>(`[aria-label="${avatarPresets[2].name}"]`)!.click(),
  );
  act(() => editor.querySelector<HTMLInputElement>('input[name="profileMessage"]')!.click());
  await flush();
  const dialog = linkDialog();
  expect(dialog).toBeDefined();
  expect(dialog.textContent).toContain("保存してから連携");
  press(dialog, "Googleで続ける");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("/api/account/guest/name");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    name: "新しい名前",
    avatarPresetId: avatarPresets[2].id,
  });
  expect(
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  requests[0]!.respond({ message: "保存に失敗しました" }, 503);
  await flush();
  expect(dialogs()).toHaveLength(2);
  expect(dialog.textContent).toContain("保存に失敗しました");
  expect(requests).toHaveLength(1);
  press(dialog, "Discordで続ける");
  requests[1]!.respond({
    ...user,
    name: "新しい名前",
    avatarPresetId: avatarPresets[2].id,
    avatarUrl: avatarPresetUrl(avatarPresets[2].id),
  });
  await flush();
  expect(requests[2]!.url).toBe("/api/auth/sign-in/social");
  expect(JSON.parse(String(requests[2]!.init.body))).toEqual({ provider: "discord" });
  requests[2]!.respond({ message: "連携開始に失敗しました" }, 503);
  await flush();
  expect(dialog.textContent).toContain("連携開始に失敗しました");
  expect(dialogs()).toHaveLength(2);
  expect(saved).toBe(0);
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  expect(dialogs()).toHaveLength(1);
  expect(editor.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe("新しい名前");
});
