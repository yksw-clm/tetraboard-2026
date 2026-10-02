import { expect, test } from "@playwright/test";

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
