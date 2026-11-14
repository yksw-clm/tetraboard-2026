import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import { AdminApp } from "../src/AdminApp";
import { AdminShell } from "../src/components/AdminShell";
import { ThemeProvider } from "../src/components/ThemeProvider";
import { act, render, flush, requests, press, clock } from "../../web/test-dom/support";

test("詳細URLの認証・一時障害からの再試行・権限喪失後の画面破棄を維持する", async () => {
  const view = render(
    <ThemeProvider>
      <MemoryRouter basename="/admin" initialEntries={["/admin/announcements"]}>
        <AdminApp />
      </MemoryRouter>
    </ThemeProvider>,
  );
  expect(requests.length).toBe(1);
  expect(view.querySelector('nav[aria-label="管理画面"]')).toBeNull();
  requests[0]!.respond({ message: "一時的なエラー" }, 503);
  await flush();
  press(view, "再試行");
  await act(async () => {
    requests[1]!.respond({ name: "管理者", username: null });
    await import("../src/Announcements");
  });
  clock.advance(500);
  await flush();
  expect(view.querySelector('nav a[aria-current="page"]')?.getAttribute("href")).toBe(
    "/admin/announcements",
  );
  requests[2]!.respond({
    announcements: [
      {
        id: "secret",
        title: "機密の利用者",
        body: "下書き",
        date: "2026-11-14",
        kind: "other",
        published: false,
        lobbyGames: [],
        createdAtMs: 1,
        updatedAtMs: 1,
        version: 1,
      },
    ],
    nextCursor: null,
  });
  await flush();
  expect(view.textContent).toContain("機密の利用者");
  // 管理権限の喪失は、どの管理APIから届いても同じ境界で処理します。
  const { adminMutation } = await import("../src/api");
  const pending = adminMutation("/api/admin/lobby-chat", "POST", {
    action: "accepting",
    accepting: false,
  });
  await act(async () => {
    requests.at(-1)!.respond({ message: "権限がありません" }, 403);
    await expect(pending).rejects.toThrow();
  });
  await flush();
  expect(view.textContent).not.toContain("機密の利用者");
  expect(view.querySelector('nav[aria-label="管理画面"]')).toBeNull();
  expect(view.textContent).toContain("権限がありません");
});
test("未ログイン時は認証先を案内し、管理画面のデータを取得しない", async () => {
  const view = render(
    <ThemeProvider>
      <MemoryRouter>
        <AdminApp />
      </MemoryRouter>
    </ThemeProvider>,
  );
  requests[0]!.respond({ message: "ログインが必要です" }, 401);
  await flush();
  expect(requests.length).toBe(1);
  expect(view.querySelector('a[href="/login?destination=admin"]')).not.toBeNull();
});
test("モバイルの管理メニューは開閉し、選択後に閉じて対象画面へ移動する", async () => {
  const previous = window.innerWidth;
  window.innerWidth = 375;
  try {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AdminShell name="管理者">
            <p>本文</p>
          </AdminShell>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await flush();
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    press(document.body, "ナビゲーションを開閉");
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("管理メニュー");
    const link = dialog.querySelector('a[href="/announcements"]') as HTMLAnchorElement;
    act(() => link.click());
    clock.advance(300);
    await flush();
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    expect(document.querySelector("header")?.textContent).toContain("お知らせ");
  } finally {
    window.innerWidth = previous;
  }
});

test("画面の表示に失敗してもメニューと再読み込みを残し、別画面へ復旧できる", async () => {
  const { AdminPageBoundary } = await import("../src/components/AdminPageBoundary");
  const { Routes, Route } = await import("react-router");
  function Broken(): never {
    throw new Error("test-render-failure");
  }
  const view = render(
    <ThemeProvider>
      <MemoryRouter>
        <AdminShell name="管理者">
          <Routes>
            <Route
              path="/"
              element={
                <AdminPageBoundary>
                  <Broken />
                </AdminPageBoundary>
              }
            />
            <Route path="/announcements" element={<p>正常な管理画面</p>} />
          </Routes>
        </AdminShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
  expect(view.textContent).toContain("画面を表示できませんでした");
  expect([...view.querySelectorAll("button")].some((b) => b.textContent === "再読み込み")).toBe(
    true,
  );
  act(() => (view.querySelector('nav a[href="/announcements"]') as HTMLAnchorElement).click());
  await flush();
  expect(view.textContent).toContain("正常な管理画面");
  expect(view.textContent).not.toContain("画面を表示できませんでした");
});
