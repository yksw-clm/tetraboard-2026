import { afterEach, expect, spyOn, test } from "bun:test";
import { BrowserSettingsButton, StampVisibilitySetting } from "../src/shared/ui/BrowserSettings";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { browserSettings, browserSettingsKey } from "../src/shared/browserSettings";
import { roomSounds } from "../src/shared/soundEffects";
import { act, clock, render, flush, wrap } from "./harness";

afterEach(() => {
  act(() => browserSettings.update({ soundEnabled: true, stampsVisible: true }));
});
function switches() {
  return [...document.querySelectorAll<HTMLInputElement>('[role="switch"]')];
}
function open(view: HTMLElement) {
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="表示・サウンド設定"]')!.click());
}

test("共通ヘッダーのゲスト向け入口から保存し、閉じても維持してフォーカスを戻す", async () => {
  const view = render(wrap()(<AppHeader homeTo="/games/shogi" homeLabel="ロビー" theme="shogi" />));
  open(view);
  await flush();
  expect(switches()).toHaveLength(2);
  expect(switches().every((button) => button.checked)).toBe(true);
  act(() => switches()[0]!.click());
  expect(JSON.parse(localStorage.getItem(browserSettingsKey)!)).toEqual({
    soundEnabled: false,
    stampsVisible: true,
  });
  expect(document.querySelector('[role="dialog"]')!.closest(".game-theme-shogi")).not.toBeNull();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  clock.advance(500);
  await flush();
  expect(document.activeElement).toBe(view.querySelector('[aria-label="表示・サウンド設定"]'));
  open(view);
  await flush();
  expect(switches()[0]!.checked).toBe(false);
});

test("共通設定とパネル用設定を共有し、別タブのOFFで再生を停止するがONで有効化を代替しない", async () => {
  const stop = spyOn(roomSounds, "stop");
  const activate = spyOn(roomSounds, "activate");
  try {
    const view = render(
      <>
        <BrowserSettingsButton />
        <StampVisibilitySetting compact />
      </>,
    );
    open(view);
    await flush();
    const raw = '{"soundEnabled":false,"stampsVisible":false}';
    localStorage.setItem(browserSettingsKey, raw);
    act(() =>
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: browserSettingsKey, newValue: raw }),
      ),
    );
    expect(stop).toHaveBeenCalled();
    expect(switches()).toHaveLength(3);
    expect(switches().every((button) => !button.checked)).toBe(true);
    const next = '{"soundEnabled":true,"stampsVisible":false}';
    localStorage.setItem(browserSettingsKey, next);
    act(() =>
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: browserSettingsKey, newValue: next }),
      ),
    );
    expect(activate).not.toHaveBeenCalled();
    act(() =>
      switches()
        .find((button) =>
          button.closest("[data-slot=switch-content]")?.textContent?.includes("カード上"),
        )!
        .click(),
    );
    expect(
      switches()
        .filter((button) =>
          button.closest("[data-slot=switch-content]")?.textContent?.includes("カード上"),
        )
        .every((button) => button.checked),
    ).toBe(true);
  } finally {
    stop.mockRestore();
    activate.mockRestore();
  }
});

test("保存不能でも切替・閉鎖・復帰で値を保持し、次の保存成功で補足を消す", async () => {
  const view = render(<BrowserSettingsButton />);
  open(view);
  await flush();
  const original = localStorage.setItem;
  Object.defineProperty(localStorage, "setItem", {
    configurable: true,
    value: () => {
      throw Error("denied");
    },
  });
  try {
    act(() => switches()[0]!.click());
    expect(document.body.textContent).toContain("次回の読み込み後は保持されない");
    act(() => window.dispatchEvent(new Event("pageshow")));
    expect(switches()[0]!.checked).toBe(false);
  } finally {
    Object.defineProperty(localStorage, "setItem", { configurable: true, value: original });
  }
  act(() => switches()[1]!.click());
  expect(document.body.textContent).not.toContain("次回の読み込み後は保持されない");
  expect(JSON.parse(localStorage.getItem(browserSettingsKey)!)).toEqual({
    soundEnabled: false,
    stampsVisible: false,
  });
});

test("保存済みOFFの復帰同期と保存キー削除を反映し、別キーの通知は無視する", () => {
  const view = render(<StampVisibilitySetting />);
  localStorage.setItem(browserSettingsKey, '{"soundEnabled":false,"stampsVisible":false}');
  act(() => window.dispatchEvent(new Event("pageshow")));
  expect(view.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false);
  act(() =>
    window.dispatchEvent(new window.StorageEvent("storage", { key: "other", newValue: null })),
  );
  expect(browserSettings.getSnapshot().soundEnabled).toBe(false);
  localStorage.removeItem(browserSettingsKey);
  act(() =>
    window.dispatchEvent(
      new window.StorageEvent("storage", { key: browserSettingsKey, newValue: null }),
    ),
  );
  expect(view.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true);
});
