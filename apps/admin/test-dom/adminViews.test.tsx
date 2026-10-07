import { expect, test } from "bun:test";
import { analyticsMetricsSchema } from "@tetraboard/protocol";
import { Dashboard } from "../src/Dashboard";
import { Users } from "../src/Users";
import { act, enter, flush, render, requests } from "../../web/test-dom/support";

const zero = Object.fromEntries(
  Object.keys(analyticsMetricsSchema.shape).map((key) => [key, key.endsWith("Rate") ? null : 0]),
);
const metrics = {
  ...zero,
  visitors: 10,
  pageViews: 30,
  started: 4,
  completed: 3,
  abandoned: 1,
  completionRate: 0.75,
  startRate: 0.4,
};
test("集計画面は値と率を表示し、日/月・内部除外をqueryに送り、更新失敗で値を保持", async () => {
  const view = render(<Dashboard game="four-shogi" />);
  expect(requests[0]!.url).toContain("game=four-shogi");
  expect(requests[0]!.url).toContain("includeInternal=false");
  requests[0]!.respond({
    collectedFromMs: 1790953200000,
    asOfMs: 1791039600000,
    totalUsers: 5,
    summary: metrics,
    buckets: [{ period: "2026-10-03", metrics }],
  });
  await flush();
  expect(view.textContent).toContain("75.0%");
  const select = view.querySelector("select")!;
  act(() => {
    select.value = "month";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(requests[1]!.url).toContain("bucket=month");
  requests[1]!.respond({
    collectedFromMs: 1790953200000,
    asOfMs: 1791039600000,
    totalUsers: 5,
    summary: metrics,
    buckets: [{ period: "2026-10", metrics }],
  });
  await flush();
  const checkbox = view.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => checkbox.click());
  expect(requests[2]!.url).toContain("includeInternal=true");
});
test("登録一覧は未完了を表示し、追加失敗と再試行、検索時の旧結果破棄を処理", async () => {
  const view = render(<Users />);
  const user = {
    name: "ユーザー",
    username: "player",
    avatarUrl: null,
    createdAtMs: 1791039600000,
    profileCompleted: true,
  };
  requests[0]!.respond({
    users: [user, { ...user, name: "", username: null, profileCompleted: false }],
    nextCursor: "next",
  });
  await flush();
  expect(view.textContent).toContain("未完了");
  expect(view.textContent).toContain("未設定");
  const more = [...view.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("もっと見る"),
  )!;
  act(() => more.click());
  expect(requests[1]!.url).toContain("cursor=next");
  requests[1]!.respond({}, 503);
  await flush();
  expect(view.textContent).toContain("表示済み");
  expect(view.textContent).toContain("ユーザー");
  act(() => more.click());
  requests[2]!.respond({ users: [{ ...user, username: "next" }], nextCursor: "last" });
  await flush();
  expect(view.textContent).toContain("@next");
  act(() => more.click());
  const additional = requests.at(-1)!;
  // Searching replaces the result component, discarding both old rows and pagination.
  enter(view.querySelector<HTMLInputElement>('[aria-label="名前・IDで検索"]')!, "  別 & 名前  ");
  act(() =>
    view
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const search = new URL(requests.at(-1)!.url, "https://tetraboard.test").searchParams;
  expect(search.get("search")).toBe("別 & 名前");
  expect(search.has("cursor")).toBe(false);
  expect(additional.init.signal?.aborted).toBe(true);
  expect(view.textContent).not.toContain("@next");
  requests.at(-1)!.respond({ users: [], nextCursor: null });
  additional.respond({ users: [user], nextCursor: null });
  await flush();
  expect(view.textContent).toContain("該当する登録ユーザーはいません");
  expect(view.textContent).not.toContain("@player");
});
