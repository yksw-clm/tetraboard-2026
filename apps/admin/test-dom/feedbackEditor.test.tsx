import { expect, test } from "bun:test";
import { MemoryRouter, Routes, Route } from "react-router";
import { FeedbackDetailPage, Feedback } from "../src/Feedback";
import { id, record } from "../test/fixtures";
import { act, enter, flush, press, render, requests } from "../../web/test-dom/support";

test("分類のversion・競合時入力保持・公開確認・再取得・削除確認・処理中ロック", async () => {
  const view = render(
    <MemoryRouter initialEntries={[`/feedback/${id}`]}>
      <Routes>
        <Route path="/feedback/:id" element={<FeedbackDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  requests.find((r) => r.url.endsWith(id))!.respond({ feedback: record, history: [] });
  requests.find((r) => r.url.endsWith("topics"))!.respond({ topics: [] });
  await flush();
  expect(view.querySelector("img")!.getAttribute("src")).toBe(
    `/api/admin/feedback/${id}/attachment`,
  );
  const note = view.querySelector("textarea")!;
  enter(note, "入力したメモ");
  press(view, "対応を保存");
  expect(requests[2]!.init.method).toBe("PATCH");
  const patch = JSON.parse(String(requests[2]!.init.body));
  expect(patch.version).toBe(1);
  expect(patch.note).toBe("入力したメモ");
  const count = requests.length;
  press(view, "処理中…");
  expect(requests).toHaveLength(count);
  requests[2]!.respond({ message: "別の操作で更新されました" }, 409);
  await flush();
  expect(view.textContent).toContain("入力を保持");
  expect(note.value).toBe("入力したメモ");
  press(view, "再取得");
  requests[3]!.respond({
    feedback: { ...record, version: 2, note: "他の管理者" },
    history: [
      {
        atMs: record.receivedAtMs,
        admin: "owner",
        changes: { note: { before: "", after: "他の管理者" } },
      },
    ],
  });
  await flush();
  expect(view.textContent).toContain("owner");
  const select = view.querySelector<HTMLSelectElement>("select")!;
  act(() => {
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  press(view, "対応を保存");
  expect(JSON.parse(String(requests[4]!.init.body))).toMatchObject({
    version: 2,
    status: "done",
    published: false,
  });
  requests[4]!.respond({ message: "公開確認が必要" }, 400);
  await flush();
  expect(view.textContent).toContain("公開確認が必要");
  const checkboxes = view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  act(() => checkboxes[0]!.click());
  press(view, "対応を保存");
  expect(JSON.parse(String(requests[5]!.init.body)).published).toBe(true);
  requests[5]!.respond({ ...record, version: 3, status: "done" });
  await flush();
  requests[6]!.respond({ feedback: { ...record, version: 3, status: "done" }, history: [] });
  await flush();
  press(view, "投稿を削除");
  expect(requests).toHaveLength(7);
  const confirm = [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
  act(() => confirm.click());
  press(view, "投稿を削除");
  expect(requests[7]!.init.method).toBe("DELETE");
  expect(JSON.parse(String(requests[7]!.init.body))).toEqual({ version: 3 });
  requests[7]!.respond(null, 204);
  await flush();
  expect(view.textContent).toContain("投稿を削除しました");
  expect(view.querySelector("img")).toBeNull();
});
test("非公開一覧の条件とcursorを送り、権限喪失では一覧を破棄", async () => {
  const view = render(
    <MemoryRouter>
      <Feedback />
    </MemoryRouter>,
  );
  requests
    .find((r) => r.url.includes("summary"))!
    .respond({
      asOfMs: record.receivedAtMs,
      unreviewed: 1,
      oldestUnreviewedMs: 1000,
      medianReviewMs: null,
      topics: [],
    });
  requests.find((r) => r.url.includes("topics"))!.respond({ topics: [] });
  requests
    .find((r) => r.url.includes("feedback?"))!
    .respond({ feedback: [record], nextCursor: "next" });
  await flush();
  expect(view.textContent).toContain(record.body.slice(0, 20));
  press(view, "次の50件");
  const more = requests.at(-1)!;
  expect(more.url).toContain("cursor=next");
  more.respond({ message: "ログインしてください" }, 401);
  await flush();
  expect(view.querySelector(`a[href="/feedback/${id}"]`)).toBeNull();
  expect(view.querySelector('a[href="/login?destination=admin"]')).not.toBeNull();
});
