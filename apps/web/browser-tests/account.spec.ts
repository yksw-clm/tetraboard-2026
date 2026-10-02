import { expect, test } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
for (const width of [320, 390, 768, 1440]) {
  test(`ログイン・アカウントメニュー・マイページを${width}pxで操作できる`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await mockAccount(page, profile);
    await page.goto("/games/four-reversi");
    const trigger = page.getByRole("button", { name: /のアカウントメニュー/ });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await expect(page.getByRole("menuitem", { name: "マイページ" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "マイページ" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("textbox", { name: "名前", exact: true })).toHaveValue(
      profile.name,
    );
    await expect(page.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue(profile.username!);
    await expect(page.getByRole("heading", { name: "戦績・棋譜" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`mypage-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByRole("textbox", { name: "名前", exact: true }).fill("変更した名前");
    await page.getByRole("textbox", { name: "ID（@ID）" }).fill("@New_ID");
    await page.getByRole("button", { name: "プロフィールを保存" }).click();
    await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
    await expect(page.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue("new_id");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "名前", exact: true })).toHaveValue(
      "変更した名前",
    );
    await page.getByRole("button", { name: /のアカウントメニュー/ }).click();
    await page.getByRole("menuitem", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/games\/four-reversi$/);
    await page.getByRole("link", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Googleで続ける" })).toBeVisible();
    await expect(page.getByText(/新しいユーザーが作成されます/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`login-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}
test("未完了の誘導、入力チェック、重複IDの再試行、送信中の連打防止", async ({ page }, info) => {
  const account = await mockAccount(page, {
    name: "",
    username: null,
    avatarUrl: null,
    profileCompleted: false,
  });
  await page.goto("/games/four-reversi");
  await expect(page).toHaveURL(/\/account\/setup$/);
  const submit = page.getByRole("button", { name: "プロフィールを作成", exact: true });
  await submit.click();
  await expect(
    page.getByText("名前は1〜10文字で入力してください。", { exact: true }),
  ).toBeVisible();
  expect(account.saves).toHaveLength(0);
  await page.getByRole("textbox", { name: "名前", exact: true }).fill("名前");
  await page.getByRole("textbox", { name: "ID（@ID）" }).fill("ab");
  await submit.click();
  expect(account.saves).toHaveLength(0);
  await page.getByRole("textbox", { name: "ID（@ID）" }).fill("New_ID");
  account.fail();
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("このIDはすでに使われています。");
  await expect(page.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue("New_ID");
  await info.attach("setup-error", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  account.succeed();
  account.hold();
  await submit.click();
  await expect(page.getByRole("button", { name: "保存しています…" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "名前", exact: true })).toBeDisabled();
  await account.release();
  await expect(page).toHaveURL(/\/account$/);
  await page.goto("/account/setup");
  await expect(page).toHaveURL(/\/account$/);
});
test("画像を変換して保存・削除し、形式エラー時は入力内容を保つ", async ({ page }) => {
  const account = await mockAccount(page, profile);
  await page.goto("/account");
  const input = page.getByLabel("アイコン画像");
  await input.setInputFiles({
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "5MB以下のJPEG・PNG・WebP画像を選んでください。",
  );
  await expect(page.getByRole("textbox", { name: "名前", exact: true })).toHaveValue(profile.name);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    canvas.getContext("2d")!.fillRect(0, 0, 400, 300);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await input.setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  const preview = page.getByRole("img", { name: "アイコンのプレビュー" });
  await expect(preview).toBeVisible();
  // WebKitのリクエスト傍受ではmultipartのファイル本体を取得できないため、表示中の実画像を検証します。
  const converted = await preview.evaluate(async (element) => {
    const blob = await (await fetch((element as HTMLImageElement).src)).blob();
    const bitmap = await createImageBitmap(blob);
    const result = {
      type: blob.type,
      bytes: blob.size,
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close();
    return result;
  });
  expect(converted.type).toBe("image/webp");
  expect(converted.bytes).toBeGreaterThan(0);
  expect(converted.bytes).toBeLessThan(1024 * 1024);
  expect([converted.width, converted.height]).toEqual([256, 256]);
  await page.getByRole("button", { name: "プロフィールを保存" }).click();
  await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
  expect((account.saves[0]!.get("avatar") as File).type).toBe("image/webp");
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await page.getByRole("button", { name: "プロフィールを保存" }).click();
  await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
  expect(account.saves[1]!.get("avatarAction")).toBe("remove");
});
test("未ログインのマイページとOAuth失敗、ログイン準備中の案内", async ({ page }) => {
  await mockAccount(page, null);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/login?error=oauth");
  await expect(page.getByRole("alert")).toContainText("ログインを完了できませんでした。");
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 503, json: { message: "Googleログインは準備中です。" } }),
  );
  await page.getByRole("button", { name: "Googleで続ける" }).click();
  await expect(page.getByRole("alert")).toHaveText("Googleログインは準備中です。");
  await expect(page.getByRole("button", { name: "Googleで続ける" })).toBeEnabled();
});
