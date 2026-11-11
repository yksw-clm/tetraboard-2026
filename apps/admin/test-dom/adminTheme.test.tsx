import { expect, test } from "bun:test";
import { ThemeProvider, ThemeSelect } from "../src/components/ThemeProvider";
import { act, renderHook, flush } from "../../web/test-dom/support";
function change(value: string) {
  const select = document.querySelector('select[aria-label="表示テーマ"]') as HTMLSelectElement;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function mount() {
  return renderHook(
    () => null,
    undefined,
    (child) => (
      <ThemeProvider>
        <ThemeSelect />
        {child}
      </ThemeProvider>
    ),
  );
}
test("テーマはOSの変更・明示選択・再表示・別タブからの変更に追従する", async () => {
  localStorage.setItem("other-setting", "unchanged");
  const original = window.matchMedia;
  let dark = false;
  const callbacks = new Set<EventListenerOrEventListenerObject>();
  window.matchMedia = () =>
    ({
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        callbacks.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        callbacks.delete(listener),
    }) as unknown as MediaQueryList;
  const os = (value: boolean) => {
    dark = value;
    act(() => {
      for (const callback of callbacks)
        if (typeof callback === "function") callback(new Event("change"));
    });
  };
  try {
    const first = mount();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    os(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    change("light");
    os(true);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    first.unmount();
    mount();
    expect(
      (document.querySelector('select[aria-label="表示テーマ"]') as HTMLSelectElement).value,
    ).toBe("light");
    const key = "tetraboard:admin-theme:v1";
    expect(localStorage.getItem(key)).toBe("light");
    localStorage.setItem(key, "dark");
    act(() => window.dispatchEvent(new window.StorageEvent("storage", { key })));
    await flush();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("other-setting")).toBe("unchanged");
    change("system");
    os(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  } finally {
    window.matchMedia = original;
  }
});
test("保存領域が利用できなくてもテーマの選択を反映し、OS設定へ戻せる", () => {
  const get = localStorage.getItem,
    set = localStorage.setItem;
  localStorage.getItem = () => {
    throw new Error("denied");
  };
  localStorage.setItem = () => {
    throw new Error("denied");
  };
  try {
    mount();
    change("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    change("system");
    expect(
      (document.querySelector('select[aria-label="表示テーマ"]') as HTMLSelectElement).value,
    ).toBe("system");
  } finally {
    localStorage.getItem = get;
    localStorage.setItem = set;
  }
});
