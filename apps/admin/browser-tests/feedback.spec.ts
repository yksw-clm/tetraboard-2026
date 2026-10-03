import { expect, test, type Page } from "@playwright/test";
import { feedbackRecordSchema } from "@tetraboard/protocol";
const id = "00000000-0000-4000-8000-000000000091";
const topicId = "00000000-0000-4000-8000-000000000092";
const now = 1791039600000;
async function fixture(page: Page) {
  await page.route("**/api/admin/session", (r) =>
    r.fulfill({ json: { name: "管理者", username: "owner" } }),
  );
  let record = feedbackRecordSchema.parse({
    id,
    kind: "bug",
    game: "four-shogi",
    body: "スマホで持ち駒が操作しづらいです。".repeat(5),
    expectation: "片手で駒を選びたい",
    steps: "画面を横にした後、持ち駒を押す",
    technical: {
      page: "room",
      game: "four-shogi",
      browser: "test browser",
      width: 390,
      height: 900,
      build: "test",
      room: { id: "12345", instanceId: topicId, roundId: topicId },
    },
    author: "guest",
    internal: false,
    receivedAtMs: now,
    expiresAtMs: now + 180 * 86400000,
    firstReviewedAtMs: null,
    status: "new",
    priority: "normal",
    topicId: null,
    note: "",
    issueUrl: "",
    hasAttachment: true,
    version: 1,
  });
  let topics: { id: string; name: string; version: number }[] = [];
  let history: { atMs: number; admin: string; changes: Record<string, unknown> }[] = [];
  let conflict = true;
  let deleted = false;
  const queries: URLSearchParams[] = [];
  await page.route(/\/api\/admin\/feedback(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.endsWith("/summary"))
      return route.fulfill({
        json: {
          asOfMs: now,
          unreviewed: 1,
          oldestUnreviewedMs: 3600000,
          medianReviewMs: 7200000,
          topics: [{ id: null, name: "未分類", posts: 3, reporters: 2 }],
        },
      });
    if (path.endsWith("/topics")) {
      if (method === "POST") {
        const data = request.postDataJSON();
        const topic = { id: topicId, name: data.name, version: 1 };
        topics.push(topic);
        return route.fulfill({ status: 201, json: topic });
      }
      return route.fulfill({ json: { topics } });
    }
    if (path.endsWith(`/topics/${topicId}`)) {
      const data = request.postDataJSON();
      topics = [{ ...topics[0]!, name: data.name, version: 2 }];
      return route.fulfill({ json: topics[0] });
    }
    if (path.endsWith("/attachment"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE8sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (path.endsWith(`/${id}`)) {
      if (deleted) return route.fulfill({ status: 404, json: { message: "削除済みです。" } });
      if (method === "DELETE") {
        deleted = true;
        return route.fulfill({ status: 204 });
      }
      if (method === "PATCH") {
        const data = request.postDataJSON();
        if (conflict) {
          conflict = false;
          record = { ...record, version: 2, note: "他の管理者のメモ" };
          return route.fulfill({
            status: 409,
            json: { message: "別の操作で更新されました。再取得してください。" },
          });
        }
        if (data.status === "done" && !data.published)
          return route.fulfill({ status: 400, json: { message: "完了には公開確認が必要です。" } });
        history.push({
          atMs: now,
          admin: "管理者",
          changes: {
            status: { before: record.status, after: data.status },
            note: { before: record.note, after: data.note },
          },
        });
        record = {
          ...record,
          status: data.status,
          priority: data.priority,
          topicId: data.topicId,
          note: data.note,
          issueUrl: data.issueUrl,
          firstReviewedAtMs: now + 1000,
          version: record.version + 1,
        };
        return route.fulfill({ json: record });
      }
      return route.fulfill({ json: { feedback: record, history } });
    }
    queries.push(url.searchParams);
    return route.fulfill({
      json: {
        feedback: deleted || url.searchParams.get("kind") === "request" ? [] : [record],
        nextCursor: null,
      },
    });
  });
  return { queries };
}
for (const width of [320, 390, 767, 768, 1280, 1440])
  test(`非公開投稿を分類し、競合・公開確認・履歴・削除を扱う ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixture(page);
    await page.goto("/admin/feedback");
    await expect(page.getByRole("heading", { name: "フィードバック", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "確認速度", exact: true })).toContainText("1件");
    await expect(page.getByRole("table")).toContainText("未分類");
    await page.getByRole("combobox", { name: "種別", exact: true }).selectOption("request");
    await expect(page.getByText("該当する投稿はありません。", { exact: true })).toBeVisible();
    expect(f.queries.at(-1)!.get("kind")).toBe("request");
    await page.getByRole("combobox", { name: "種別", exact: true }).selectOption("");
    await page.getByRole("button", { name: "テーマを管理" }).click();
    await page.getByLabel("テーマ名", { exact: true }).fill("持ち駒の操作");
    await page.getByRole("button", { name: "テーマを保存" }).click();
    await expect(
      page
        .getByRole("combobox", { name: "テーマ", exact: true })
        .getByRole("option", { name: "持ち駒の操作" }),
    ).toHaveCount(1);
    await page.getByLabel("編集するテーマ").selectOption(topicId);
    await page.getByLabel("テーマ名", { exact: true }).fill("スマホの持ち駒操作");
    await page.getByRole("button", { name: "テーマを保存" }).click();
    await expect(
      page
        .getByRole("combobox", { name: "テーマ", exact: true })
        .getByRole("option", { name: "スマホの持ち駒操作" }),
    ).toHaveCount(1);
    await page.getByRole("link", { name: /スマホで持ち駒が操作しづらい/ }).click();
    await expect(page.getByRole("heading", { name: "投稿の確認", exact: true })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "投稿に添付されたスクリーンショット" }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "対応状況", exact: true }).selectOption("working");
    await page.getByRole("combobox", { name: "優先度", exact: true }).selectOption("high");
    await page.getByRole("combobox", { name: "テーマ", exact: true }).selectOption(topicId);
    await page
      .getByRole("textbox", { name: "運営メモ", exact: true })
      .fill("再現確認できたので修正します");
    await page
      .getByLabel("関連GitHub Issue")
      .fill("https://github.com/yksw-clm/tetraboard-2026/issues/52");
    await page.getByRole("button", { name: "対応を保存" }).click();
    await expect(page.getByRole("alert")).toContainText("別の操作で更新");
    await expect(page.getByRole("textbox", { name: "運営メモ", exact: true })).toHaveValue(
      "再現確認できたので修正します",
    );
    await page.getByRole("button", { name: "再取得", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "運営メモ", exact: true })).toHaveValue(
      "他の管理者のメモ",
    );
    await page.getByRole("combobox", { name: "対応状況", exact: true }).selectOption("done");
    await page.getByRole("textbox", { name: "運営メモ", exact: true }).fill("修正を公開しました");
    await page.getByRole("button", { name: "対応を保存" }).click();
    await expect(page.getByRole("alert")).toContainText("公開確認");
    await page.getByLabel("本番で公開・動作を確認しました").check();
    await page.getByRole("button", { name: "対応を保存" }).click();
    await expect(page.getByText("未確認 → 完了", { exact: false })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await info.attach(`feedback-admin-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await expect(page.getByRole("button", { name: "投稿を削除", exact: true })).toBeDisabled();
    await page.getByLabel("投稿と画像を削除することを確認しました").check();
    await page.getByRole("button", { name: "投稿を削除", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("投稿を削除しました");
    await page.getByRole("link", { name: "一覧へ戻る" }).click();
    await expect(page.getByText("該当する投稿はありません。", { exact: true })).toBeVisible();
  });

test("管理権限が失われた一覧はデータを保持せずログインへ案内する", async ({ page }) => {
  await fixture(page);
  await page.goto("/admin/feedback");
  await expect(page.getByRole("link", { name: /スマホで持ち駒が操作しづらい/ })).toBeVisible();
  await page.route(/\/api\/admin\/feedback(?:\/.*)?(?:\?.*)?$/, (r) =>
    r.fulfill({ status: 401, json: { message: "ログインしてください。" } }),
  );
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("ログインしてください");
  await expect(page.getByRole("link", { name: /スマホで持ち駒が操作しづらい/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ログインへ" })).toBeVisible();
});
