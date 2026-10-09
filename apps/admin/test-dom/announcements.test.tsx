import { expect, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  AnnouncementCreatePage,
  AnnouncementEditPage,
  Announcements,
  announcementToday,
} from "../src/Announcements";
import { act, enter, flush, press, render, requests } from "../../web/test-dom/support";
const record = {
  id: "feedback",
  title: "元のタイトル",
  body: "最初\n二行目",
  date: "2026-10-08",
  kind: "feature",
  published: false,
  lobbyGames: ["four-reversi"],
  createdAtMs: 1,
  updatedAtMs: 1,
  version: 1,
};
function changeTitle(view: HTMLElement, title: string) {
  enter(view.querySelector("input")!, title);
}
const route = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/announcements/new" element={<AnnouncementCreatePage />} />
      <Route path="/announcements/:id" element={<AnnouncementEditPage />} />
    </Routes>
  </MemoryRouter>
);

test("新規の既定値・文字数検証・プレビュー・保存ロックと作成後の編集", async () => {
  expect(announcementToday(Date.parse("2026-10-07T15:00:00Z"))).toBe("2026-10-08");
  const view = render(route("/announcements/new"));
  expect(view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').length).toBe(4);
  expect(
    [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((e) => !e.checked),
  ).toBe(true);
  expect(view.querySelector("select")!.value).toBe("other");
  press(view, "保存");
  expect(requests).toHaveLength(0);
  changeTitle(view, "新しいお知らせ");
  enter(view.querySelector("textarea")!, "一行目\n二行目");
  expect(view.querySelector('[aria-label="ロビー表示プレビュー"]')!.textContent).toContain(
    "一行目",
  );
  expect(view.querySelector('[aria-label="ロビー表示プレビュー"]')!.textContent).not.toContain(
    "二行目",
  );
  const checkboxes = view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  act(() => {
    checkboxes[0]!.click();
    checkboxes[2]!.click();
  });
  press(view, "保存");
  press(view, "保存");
  expect(requests).toHaveLength(1);
  const input = JSON.parse(String(requests[0]!.init.body));
  expect(input).toMatchObject({
    title: "新しいお知らせ",
    body: "一行目\n二行目",
    published: true,
    lobbyGames: ["four-shogi"],
    kind: "other",
  });
  expect(view.querySelector('[aria-label="保存"]')!.getAttribute("disabled")).not.toBeNull();
  requests[0]!.respond({ ...record, ...input }, 201);
  await flush();
  expect(requests[1]!.url).toBe("/api/admin/announcements/feedback");
  requests[1]!.respond({ ...record, ...input });
  await flush();
  expect(view.textContent).toContain("お知らせを編集");
});
test("保存失敗・競合時の入力保持、明示的な再取得、成功後の更新番号と権限喪失", async () => {
  const view = render(route("/announcements/feedback"));
  requests[0]!.respond(record);
  await flush();
  changeTitle(view, "保持するタイトル");
  press(view, "保存");
  expect(JSON.parse(String(requests[1]!.init.body)).version).toBe(1);
  requests[1]!.respond({ message: "保存失敗" }, 503);
  await flush();
  expect(view.querySelector("input")!.value).toBe("保持するタイトル");
  press(view, "保存");
  requests[2]!.respond({ message: "別の操作で更新されました" }, 409);
  await flush();
  expect(view.querySelector("input")!.value).toBe("保持するタイトル");
  press(view, "最新データを読み直す");
  requests[3]!.respond({ ...record, title: "別の編集", version: 2 });
  await flush();
  expect(view.querySelector("input")!.value).toBe("別の編集");
  press(view, "保存");
  expect(JSON.parse(String(requests[4]!.init.body)).version).toBe(2);
  requests[4]!.respond({ ...record, title: "別の編集", version: 3 });
  await flush();
  press(view, "保存");
  expect(JSON.parse(String(requests[5]!.init.body)).version).toBe(3);
  requests[5]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.querySelector("input")).toBeNull();
  requests[6]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.textContent).not.toContain("別の編集");
});
test("管理一覧で公開状態・掲載先・ページングを表示し権限喪失で破棄する", async () => {
  const view = render(
    <MemoryRouter>
      <Announcements />
    </MemoryRouter>,
  );
  requests[0]!.respond({ announcements: [record], nextCursor: "next" });
  await flush();
  expect(view.textContent).toContain("非公開");
  expect(view.textContent).toContain("四人リバーシ");
  expect(
    [...view.querySelectorAll("a")].some(
      (a) => a.getAttribute("href") === "/announcements?cursor=next",
    ),
  ).toBe(true);
  press(view, "更新");
  requests[1]!.respond({ message: "権限がありません" }, 403);
  await flush();
  expect(view.textContent).not.toContain(record.title);
});
