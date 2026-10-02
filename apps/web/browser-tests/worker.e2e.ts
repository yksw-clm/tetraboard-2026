import { expect, test } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";

test("ローカルWorkerで作成・CPU対局・チャット・退室する", async ({ page }) => {
  await page.goto("/games/four-reversi");
  await page.getByRole("button", { name: "すぐ遊ぶ", exact: true }).click();
  await page.getByRole("textbox", { name: "ニックネーム" }).fill("動作確認");
  await page.getByRole("button", { name: "CPUとの待機室へ" }).click();
  await expect(page).toHaveURL(/\/rooms\/\d{5}$/);
  await expect(page.getByTestId("player-card")).toHaveCount(4);
  await page.getByRole("button", { name: "対局開始", exact: true }).click();
  const legalMove = page.getByRole("button", { name: /置けます/ }).first();
  await expect(legalMove).toBeEnabled({ timeout: 20_000 });
  await legalMove.click();
  const input = page.getByRole("textbox", { name: "メッセージ" });
  await input.fill("ローカルWorker接続確認");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("list", { name: "チャット履歴" })).toContainText(
    "ローカルWorker接続確認",
  );
  await page.reload();
  await expect(page.getByTestId("player-card")).toHaveCount(4);
  await expect(page.getByRole("list", { name: "チャット履歴" })).toContainText(
    "ローカルWorker接続確認",
  );
  await page.getByRole("button", { name: "退室", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "退室する" }).click();
  await expect(page).toHaveURL(/games\/four-reversi$/);
});

test("本番ビルドで同一オリジンの資産を使いWebPへ変換する", async ({ page }) => {
  // 画像変換では認証API境界だけを固定し、JS・WASM・画像デコードは実際の本番ビルドを使います。
  await mockAccount(page, profile);
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:8788/") && !request.url().startsWith("blob:"))
      external.push(request.url());
  });
  await page.goto("/account");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    canvas.getContext("2d")!.fillRect(0, 0, 512, 256);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByLabel("アイコン画像").setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  const preview = page.getByRole("img", { name: "アイコンのプレビュー" });
  await expect(preview).toBeVisible();
  const image = await preview.evaluate(async (element) => {
    const blob = await (await fetch((element as HTMLImageElement).src)).blob();
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height, type: blob.type };
    bitmap.close();
    return result;
  });
  expect(image).toEqual({ width: 256, height: 256, type: "image/webp" });
  expect(external).toEqual([]);
});
