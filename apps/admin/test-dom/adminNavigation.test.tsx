import { SidebarProvider } from "../src/components/ui/sidebar";
import { ThemeProvider } from "../src/components/ThemeProvider";
import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { AdminNavigation } from "../src/AdminNavigation";
import { act, render } from "../../web/test-dom/support";

function Location() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output>{pathname}</output>
      <button onClick={() => void navigate(-1)}>戻る</button>
    </>
  );
}

test("画面選択は全管理メニューへadmin配下で移動し、PCリンクの現在地も同期する", () => {
  const view = render(
    <MemoryRouter basename="/admin" initialEntries={["/admin/"]}>
      <ThemeProvider>
        <SidebarProvider>
          <AdminNavigation name="管理者" />
        </SidebarProvider>
      </ThemeProvider>
      <Location />
    </MemoryRouter>,
  );
  const select = view.querySelector("select")!;
  const destinations = [
    ["/", "全体概要"],
    ["/acquisition", "集客・登録"],
    ["/retention", "再対局・認定"],
    ["/tracking-links", "計測リンク"],
    ...gameIds.map((id) => [gameCatalog[id].lobbyPath, gameCatalog[id].name]),
    ["/users", "ユーザー"],
    ["/lobby-chat", "公開チャット"],
    ["/feedback", "フィードバック"],
    ["/announcements", "お知らせ"],
    ["/tournaments", "大会"],
  ];
  expect(select.labels?.[0]?.textContent).toContain("表示画面");
  expect(select.options.length).toBe(destinations.length);
  for (const [path, label] of destinations) {
    expect([...select.options].find((option) => option.value === path)?.textContent).toBe(label);
    act(() => {
      select.value = path!;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(view.querySelector("output")?.textContent).toBe(path);
    const current = view.querySelectorAll('nav a[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.textContent).toBe(label);
    expect(current[0]?.getAttribute("href")).toBe(`/admin${path === "/" ? "" : path}`);
  }
  act(() => [...view.querySelectorAll("button")].find((b) => b.textContent === "戻る")!.click());
  expect(select.value).toBe("/announcements");
});

test("詳細・新規作成への直接アクセスは親メニューを現在地にし、画面切り替えと戻るに対応する", () => {
  for (const path of [
    "/feedback/example",
    "/announcements/new",
    "/announcements/example",
    "/tournaments/new",
    "/tournaments/example",
  ]) {
    const parent = `/${path.split("/")[1]}`;
    const view = render(
      <MemoryRouter basename="/admin" initialEntries={[`/admin${path}`]}>
        <ThemeProvider>
          <SidebarProvider>
            <AdminNavigation name="管理者" />
          </SidebarProvider>
        </ThemeProvider>
        <Location />
      </MemoryRouter>,
    );
    const select = view.querySelector("select")!;
    expect(select.value).toBe(parent);
    expect(view.querySelector('nav a[aria-current="page"]')?.getAttribute("href")).toBe(
      `/admin${parent}`,
    );
    act(() => {
      select.value = "/";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(view.querySelector("output")?.textContent).toBe("/");
    act(() => [...view.querySelectorAll("button")].find((b) => b.textContent === "戻る")!.click());
    expect(select.value).toBe(parent);
    expect(view.querySelector("output")?.textContent).toBe(path);
  }
});

test("管理画面で表示テーマを選択できる", () => {
  const view = render(
    <MemoryRouter>
      <ThemeProvider>
        <SidebarProvider>
          <AdminNavigation name="管理者" />
        </SidebarProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  expect(view.querySelector('select[aria-label="表示テーマ"]')).not.toBeNull();
});
