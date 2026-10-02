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
    await expect(page.getByRole("heading", { name: profile.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "マイページ", exact: true })).toHaveCount(0);
    await expect(page.getByText("名前・ID・アイコンを変更できます。", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(
      page.locator("main").getByText(`@${profile.username}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "戦績・棋譜" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`mypage-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const edit = page.getByRole("button", { name: "プロフィールを編集", exact: true });
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "プロフィールを編集", exact: true });
    await expect(dialog.getByRole("textbox", { name: "名前", exact: true })).toHaveValue(
      profile.name,
    );
    await expect(dialog.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue(profile.username!);
    await dialog.getByRole("textbox", { name: "名前", exact: true }).fill("未保存の名前");
    await dialog.getByRole("textbox", { name: "ID（@ID）" }).fill("unsaved_id");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(dialog.getByRole("textbox", { name: "名前", exact: true })).toHaveValue(
      profile.name,
    );
    await expect(dialog.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue(profile.username!);
    const camera = dialog.getByRole("button", { name: "アイコン画像を選択", exact: true });
    const box = await camera.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await dialog.getByRole("button", { name: "保存", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await info.attach(`profile-dialog-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await dialog.getByRole("textbox", { name: "名前", exact: true }).fill("変更した名前");
    await dialog.getByRole("textbox", { name: "ID（@ID）" }).fill("@New_ID");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
    await expect(edit).toBeFocused();
    await expect(page.getByRole("heading", { name: "変更した名前", exact: true })).toBeVisible();
    await expect(page.locator("main").getByText("@new_id", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /のアカウントメニュー/ })).toHaveAccessibleName(
      "変更した名前のアカウントメニュー",
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "変更した名前", exact: true })).toBeVisible();
    await edit.click();
    await expect(dialog.getByRole("textbox", { name: "ID（@ID）" })).toHaveValue("new_id");
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(edit).toBeFocused();
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
  await expect(page.getByRole("button", { name: "アイコン画像を選択", exact: true })).toBeVisible();
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
test("編集の入力不備と保存失敗を保持し、保存中の閉鎖・再送信を防ぐ", async ({ page }) => {
  const account = await mockAccount(page, profile);
  await page.goto("/account");
  await page.getByRole("button", { name: "プロフィールを編集", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "名前", exact: true });
  const id = dialog.getByRole("textbox", { name: "ID（@ID）" });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  await name.fill("");
  await save.click();
  await expect(
    dialog.getByText("名前は1〜10文字で入力してください。", { exact: true }),
  ).toBeVisible();
  expect(account.saves).toHaveLength(0);
  await name.fill("変更した名前");
  await id.fill("@New_ID");
  account.fail();
  await save.click();
  await expect(dialog.getByRole("alert")).toHaveText("このIDはすでに使われています。");
  await expect(name).toHaveValue("変更した名前");
  await expect(id).toHaveValue("@New_ID");
  account.succeed();
  account.hold();
  await save.click();
  await expect(dialog.getByRole("button", { name: "保存しています…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "アイコン画像を選択", exact: true }),
  ).toBeDisabled();
  await expect(name).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  expect(account.saves).toHaveLength(1);
  await account.release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "変更した名前", exact: true })).toBeVisible();
  expect(account.saves).toHaveLength(2);
});
test("画像を変換して保存・削除し、形式エラー時は入力内容を保つ", async ({ page }) => {
  const account = await mockAccount(page, profile);
  await page.goto("/account");
  const edit = page.getByRole("button", { name: "プロフィールを編集", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog");
  const input = page.getByLabel("アイコン画像", { exact: true });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "アイコン画像を選択", exact: true }).click();
  await (
    await chooser
  ).setFiles({
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
  // ブラウザの画像エンコードを一時停止し、実際の変換結果と処理中の操作抑止を両方確認します。
  await page.evaluate(() => {
    const native = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      (window as typeof window & { resumeAvatarEncoding?: () => void }).resumeAvatarEncoding =
        () => {
          HTMLCanvasElement.prototype.toBlob = native;
          native.call(this, callback, type, quality);
        };
    };
  });
  await input.setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(dialog.getByRole("status")).toHaveText("画像を読み込んでいます…");
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as typeof window & { resumeAvatarEncoding?: () => void })
            .resumeAvatarEncoding,
      ),
    )
    .toBe("function");
  await page.evaluate(() =>
    (window as typeof window & { resumeAvatarEncoding?: () => void }).resumeAvatarEncoding!(),
  );
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
  // 閉じると画像の下書きも破棄され、次回は保存済みの状態で開きます。
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await edit.click();
  await expect(dialog.getByRole("img", { name: "アイコンのプレビュー" })).toHaveCount(0);
  expect(account.saves).toHaveLength(0);
  await input.setInputFiles({
    name: "icon.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(preview).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
  expect((account.saves[0]!.get("avatar") as File).type).toBe("image/webp");
  await expect(page.getByRole("img", { name: "プロフィールアイコン" })).toHaveAttribute(
    "src",
    "/test-avatar.webp",
  );
  await edit.click();
  await dialog.getByRole("button", { name: "アイコンを削除", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "アイコンを削除", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("プロフィールを保存しました。");
  expect(account.saves[1]!.get("avatarAction")).toBe("remove");
  await expect(page.getByRole("img", { name: "プロフィールアイコン" })).toHaveCount(0);
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
