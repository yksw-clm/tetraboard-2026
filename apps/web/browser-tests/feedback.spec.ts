import { expect, test, type Page } from "@playwright/test";
import { mockLobby, mockRoom, playingRoom, waitingRoom, playerIds } from "./fixtures";
import { createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { roomSchema } from "@tetraboard/protocol";
import { playingShogiRoom, finishedShogiRound } from "./fourShogiFixtures";
import { mockAccount, profile } from "./accountFixtures";
const receipt = "00000000-0000-4000-8000-000000000099";
const widths = [320, 390, 767, 768, 1280, 1440];
async function capture(page: Page, failFirst = false) {
  const requests: { input: Record<string, unknown>; file: File | null }[] = [];
  await page.route("**/api/feedback", async (route) => {
    const data = await new Response(new Uint8Array(route.request().postDataBuffer()!), {
      headers: { "Content-Type": route.request().headers()["content-type"] },
    }).formData();
    requests.push({
      input: JSON.parse(String(data.get("input"))),
      file: data.get("attachment") as File | null,
    });
    await route.fulfill(
      failFirst && requests.length === 1
        ? { status: 503, json: { message: "保存できませんでした。入力を残しています。" } }
        : { status: 201, json: { id: receipt } },
    );
  });
  return requests;
}
async function screenshotFile(page: Page) {
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1800;
    c.height = 900;
    const context = c.getContext("2d")!;
    context.fillStyle = "#338866";
    context.fillRect(0, 0, 1800, 900);
    return c.toDataURL("image/png").split(",")[1]!;
  });
  return { name: "screenshot.png", mimeType: "image/png", buffer: Buffer.from(encoded, "base64") };
}

for (const game of ["four-reversi", "four-shogi"] as const)
  for (const width of widths) {
    test(`${game} ロビーで画像付き不具合を再送し、お知らせを確認 ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await mockLobby(page);
      const requests = await capture(page, true);
      await page.goto(`/games/${game}`);
      await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("combobox", { name: "対象", exact: true })).toHaveValue(game);
      await dialog.getByRole("button", { name: "送信する", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("種別を選び");
      await dialog.getByLabel("種別（必須）").selectOption("bug");
      await dialog.getByLabel("内容（必須）").fill("画面を横にすると盤面が読めません。");
      await dialog.getByLabel("期待していた動作（任意）").fill("横向きでも遊べること");
      await dialog.getByLabel("再現手順（任意）").fill("スマホを横にする");
      await dialog
        .getByLabel("スクリーンショット（任意・1枚）")
        .setInputFiles(await screenshotFile(page));
      await expect(
        dialog.getByRole("img", { name: "添付するスクリーンショットのプレビュー" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("img", { name: "添付するスクリーンショットのプレビュー" }),
      ).toHaveJSProperty("naturalWidth", 1600);
      await expect(
        dialog.getByRole("img", { name: "添付するスクリーンショットのプレビュー" }),
      ).toHaveJSProperty("naturalHeight", 800);
      await dialog.getByRole("button", { name: "送信する", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("保存できません");
      await expect(dialog.getByLabel("内容（必須）")).toHaveValue(
        "画面を横にすると盤面が読めません。",
      );
      await expect(dialog.getByRole("img")).toBeVisible();
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
      await expect(page.getByRole("button", { name: "不具合・ご意見", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
      await expect(dialog.getByLabel("内容（必須）")).toHaveValue(
        "画面を横にすると盤面が読めません。",
      );
      await dialog.getByRole("button", { name: "送信する", exact: true }).click();
      await expect(dialog.getByRole("status")).toContainText("ご意見を受け付けました");
      expect(requests).toHaveLength(2);
      expect(requests[0]!.input).toEqual(requests[1]!.input);
      expect(requests[1]!.input).toMatchObject({
        game,
        kind: "bug",
        accountRequired: false,
        technical: { page: "lobby", game, width, height: 900 },
      });
      expect(requests[1]!.file?.type).toBe("image/webp");
      expect(requests[1]!.file!.size).toBeLessThanOrEqual(1024 * 1024);
      // WebKitのroute差替えではBlobの本文を取得できないため、変換は表示画像、実送信はWorker E2Eで確認します。
      await info.attach(`feedback-${game}-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await dialog.getByRole("link", { name: "改善のお知らせを見る" }).click();
      await expect(
        page.getByRole("heading", { name: "改善のお知らせ", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test(`${game} 対局中のフォームで入力・画像を保持し接続を維持 ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockRoom(
        page,
        game === "four-reversi" ? playingRoom() : playingShogiRoom(),
      );
      await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
      const requests = await capture(page);
      await page.goto("/rooms/12345?invite=00000000-0000-4000-8000-000000000010");
      if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("種別（必須）").selectOption("bug");
      await dialog.getByLabel("内容（必須）").fill("ルーム内の時計表示を確認したい");
      await expect(
        dialog.getByText("入力中も対局と時計は進みます。", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByLabel("技術情報を添付する")).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(fixture.connectedSocketCount).toBe(1);
      expect(fixture.received.filter((m) => m.type === "room.auth")).toHaveLength(1);
      await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
      await expect(dialog.getByLabel("内容（必須）")).toHaveValue("ルーム内の時計表示を確認したい");
      await dialog.getByRole("button", { name: "送信する", exact: true }).click();
      await expect(dialog.getByRole("status")).toContainText("受け付けました");
      expect(requests[0]!.input.technical).toMatchObject({
        page: "room",
        room: {
          id: "12345",
          instanceId: "00000000-0000-4000-8000-000000000010",
          roundId: game === "four-shogi" ? "00000000-0000-4000-8000-000000000020" : null,
        },
      });
      expect(JSON.stringify(requests[0]!.input)).not.toContain("invite=");
      expect(JSON.stringify(requests[0]!.input)).not.toContain("token");
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
      if (width < 1280) await page.getByRole("tab", { name: "盤面", exact: true }).click();
      await expect(page.getByTestId("player-card")).toHaveCount(4);
      expect(fixture.connectedSocketCount).toBe(1);
      if (game === "four-reversi") {
        await page
          .getByRole("button", { name: /置けます/ })
          .first()
          .click();
        expect(fixture.received.some((m) => m.type === "room.game.action")).toBe(true);
      } else {
        const room = playingShogiRoom();
        const action = room.legalActions.find((a) => a.type === "movePiece" && !a.promote)!;
        if (action.type !== "movePiece") throw new Error("move fixture");
        const square = (p: { x: number; y: number }) =>
          `[data-square="${"ABCDEFGHI"[p.x]}${p.y + 1}"]`;
        await page.locator(square(action.from)).click();
        await page.locator(square(action.to)).click();
        expect(fixture.received.some((m) => m.type === "room.game.action")).toBe(true);
      }
    });
  }

for (const completed of [true, false])
  test(`直接受付はプロフィール完了=${completed}でも開き、技術情報なしの要望を送る`, async ({
    page,
  }) => {
    await mockAccount(page, { ...profile, profileCompleted: completed });
    const requests = await capture(page);
    await page.goto("/feedback");
    await expect(page).toHaveURL(/\/feedback$/);
    await page.getByLabel("種別（必須）").selectOption("request");
    await page.getByLabel("内容（必須）").fill("友人との対局を振り返りたい");
    await page
      .getByLabel("何ができると嬉しいですか？（任意）")
      .fill("次に集まるときに前の対局を話したい");
    await page.getByRole("button", { name: "送信する", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("受け付けました");
    expect(requests[0]!.input).toMatchObject({
      accountRequired: true,
      kind: "request",
      technical: null,
      steps: "",
    });
    await page.getByRole("button", { name: "別のご意見を送る" }).click();
    await expect(page.getByLabel("内容（必須）")).toHaveValue("");
  });

test("技術情報の取り消し、入力上限、画像形式エラーと取り消し、再読込による破棄", async ({
  page,
}) => {
  await mockLobby(page);
  const requests = await capture(page);
  await page.goto("/feedback");
  await page.getByLabel("種別（必須）").selectOption("bug");
  await page.getByLabel("内容（必須）").fill("a".repeat(2001));
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("2,000文字");
  expect(requests).toHaveLength(0);
  await page.getByLabel("内容（必須）").fill("小さな表示の違和感");
  await page
    .getByLabel("スクリーンショット（任意・1枚）")
    .setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg />") });
  await expect(page.getByRole("alert")).toContainText("JPEG・PNG・WebP");
  await expect(page.getByLabel("内容（必須）")).toHaveValue("小さな表示の違和感");
  await page
    .getByLabel("スクリーンショット（任意・1枚）")
    .setInputFiles(await screenshotFile(page));
  await expect(page.getByRole("img", { name: /プレビュー/ })).toBeVisible();
  await page.getByRole("button", { name: "画像を取り消す" }).click();
  await expect(page.getByRole("img", { name: /プレビュー/ })).toHaveCount(0);
  await page.getByLabel("技術情報を添付する").uncheck();
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("受け付けました");
  expect(requests[0]!.input.technical).toBeNull();
  expect(requests[0]!.file).toBeNull();
  await page.getByRole("button", { name: "別のご意見を送る" }).click();
  await page.getByLabel("内容（必須）").fill("保存しない下書き");
  await page.reload();
  await expect(page.getByLabel("内容（必須）")).toHaveValue("");
});

for (const destination of ["room", "replay"])
  test(`${destination} 取得エラーから非公開受付を開く`, async ({ page }) => {
    await mockLobby(page);
    if (destination === "room")
      await page.route("**/api/rooms/12345", (r) =>
        r.fulfill({ status: 503, json: { error: "service_unavailable" } }),
      );
    else {
      await mockAccount(page, profile);
      await page.route("**/api/account/matches/*", (r) =>
        r.fulfill({ status: 503, json: { message: "棋譜が取得できません" } }),
      );
    }
    await page.goto(destination === "room" ? "/rooms/12345" : `/account/matches/${receipt}`);
    await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("投稿は公開されません。");
  });

for (const game of ["four-reversi", "four-shogi"] as const)
  test(`${game} 画面幅をまたぐ変更と終局でも下書き・画像を保持する`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const fixture = await mockRoom(
      page,
      game === "four-reversi" ? playingRoom() : playingShogiRoom(),
    );
    await capture(page, true);
    await page.goto("/rooms/12345");
    await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "不具合・ご意見", exact: true });
    await dialog.getByLabel("種別（必須）").selectOption("bug");
    await dialog.getByLabel("内容（必須）").fill("回転しても入力を残したい");
    await dialog
      .getByLabel("スクリーンショット（任意・1枚）")
      .setInputFiles(await screenshotFile(page));
    await expect(dialog.getByRole("img", { name: /プレビュー/ })).toHaveJSProperty(
      "naturalWidth",
      1600,
    );
    await dialog.getByRole("button", { name: "送信する", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("保存できません");
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByText("送る技術情報を確認", { exact: true }).click();
    await expect(dialog.getByText("画面サイズ：390×900", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("内容（必須）")).toHaveValue("回転しても入力を残したい");
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.getByRole("button", { name: "不具合・ご意見", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("button", { name: "不具合・ご意見", exact: true }).click();
    const initial = createInitialState("doubles");
    const end = eliminateColor(initial, "black");
    if (!end.ok) throw new Error("Invalid fixture");
    fixture.update(
      game === "four-shogi"
        ? finishedShogiRound().room
        : roomSchema.parse({
            ...waitingRoom(),
            settings: { ...waitingRoom().settings, mode: "doubles" },
            lastRound: {
              game: end.state,
              players: playerIds.map((id, index) => ({
                id,
                name: `参加者${index + 1}`,
                color: ["black", "white", "red", "blue"][index],
              })),
              replay: {
                id: receipt,
                initial,
                steps: [
                  {
                    action: { type: "eliminate", color: "black", reason: "resigned" },
                    game: end.state,
                    passedColors: [],
                  },
                ],
              },
            },
          }),
    );
    await expect(dialog.getByLabel("内容（必須）")).toHaveValue("回転しても入力を残したい");
    await expect(dialog.getByRole("img", { name: /プレビュー/ })).toHaveJSProperty(
      "naturalWidth",
      1600,
    );
    await expect(page.getByRole("dialog", { name: "対局結果", exact: true })).toHaveCount(0);
    expect(fixture.connectedSocketCount).toBe(1);
    await dialog.getByRole("button", { name: "送信する", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("受け付けました");
  });
