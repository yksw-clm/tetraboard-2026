import { expect, test } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
import { adminUsersSchema } from "@tetraboard/protocol";

test("ローカルWorkerで作成・CPU対局・チャット・退室する", async ({ page }) => {
  const measured = page.waitForResponse((response) =>
    response.url().endsWith("/api/analytics/pageviews"),
  );
  await page.goto("/games/four-reversi");
  const measurement = await measured;
  expect(measurement.status()).toBe(204);
  await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
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
  await page.getByRole("button", { name: "プロフィールを編集", exact: true }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    canvas.getContext("2d")!.fillRect(0, 0, 512, 256);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByLabel("アイコン画像", { exact: true }).setInputFiles({
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

test("将棋を独立した4人で開始し、観戦・チャット・再接続・棋譜・再戦を行う", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(
    Array.from({ length: 5 }, () =>
      browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ja-JP" }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    const host = pages[0]!;
    await host.goto("http://127.0.0.1:8788/games/four-shogi");
    await host.getByRole("button", { name: /^ルームを作る/ }).click();
    await host.getByRole("textbox", { name: "ニックネーム" }).fill("将棋接続1");
    await host
      .getByRole("dialog")
      .getByRole("button", { name: "ルームを作る", exact: true })
      .click();
    await expect(host).toHaveURL(/\/rooms\/\d{5}$/);
    const roomId = new URL(host.url()).pathname.split("/").at(-1)!;
    const roomURL = host.url();
    for (let i = 1; i < 4; i++) {
      const page = pages[i]!;
      await page.goto("http://127.0.0.1:8788/games/four-shogi");
      await page.getByRole("button", { name: /^ルーム番号で参加/ }).click();
      await page.getByRole("textbox", { name: "ニックネーム" }).fill("将棋接続" + (i + 1));
      await page.getByRole("textbox", { name: "ルーム番号", exact: true }).fill(roomId);
      await page.getByRole("dialog").getByRole("button", { name: "参加する", exact: true }).click();
      await expect(page).toHaveURL(new RegExp("/rooms/" + roomId + "$"));
    }
    const spectator = pages[4]!;
    await spectator.goto(roomURL);
    await expect(spectator.getByText("観戦中です", { exact: true })).toBeVisible();
    await expect(host.getByTestId("player-card")).toHaveCount(4);
    await Promise.all(
      pages
        .slice(0, 4)
        .map((page) => page.getByRole("button", { name: "準備完了", exact: true }).click()),
    );
    await expect(host.getByRole("button", { name: "対局開始", exact: true })).toBeEnabled();
    await host.getByRole("button", { name: "ルーム設定" }).click();
    await host.getByText("OFF", { exact: true }).click();
    await expect(host.getByRole("radio", { name: "OFF", exact: true })).toBeChecked();
    await expect(host.getByRole("button", { name: "対局開始", exact: true })).toBeDisabled();
    for (const page of pages.slice(0, 4))
      await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
    await Promise.all(
      pages
        .slice(0, 4)
        .map((page) => page.getByRole("button", { name: "準備完了", exact: true }).click()),
    );
    await host.getByRole("button", { name: "対局開始", exact: true }).click();
    const readRoom = async () =>
      (await (await host.request.get("http://127.0.0.1:8788/api/rooms/" + roomId)).json()).room;
    await expect.poll(async () => (await readRoom()).status).toBe("playing");
    let snapshot = await readRoom();
    const firstRound = snapshot.roundId;
    expect(snapshot.settings.game).toBe("four-shogi");
    expect(snapshot.settings.threePlayerAttackProhibited).toBe(false);
    expect(snapshot.game.board.flat().filter(Boolean)).toHaveLength(36);
    expect(snapshot.game).not.toHaveProperty("repetitions");
    const currentPage = (data: typeof snapshot) => {
      const name = data.players.find((p: { side: string }) => p.side === data.game.turn).name;
      return pages[Number(name.slice(-1)) - 1]!;
    };
    const mover = currentPage(snapshot);
    const action = snapshot.legalActions.find(
      (a: { type: string; promote: boolean }) => a.type === "movePiece" && !a.promote,
    )!;
    const square = (position: { x: number; y: number }) =>
      '[data-square="' + "ABCDEFGHI"[position.x] + (position.y + 1) + '"]';
    await mover.locator(square(action.from)).click();
    await mover.locator(square(action.to)).click();
    await expect.poll(async () => (await readRoom()).positionRevision).toBe(1);
    await expect(spectator.locator('[data-last-move="to"]')).toHaveCount(1);
    const input = host.getByRole("textbox", { name: "メッセージ" });
    await input.fill("将棋4人接続確認");
    await host.getByRole("button", { name: "送信", exact: true }).click();
    await expect(spectator.getByRole("list", { name: "チャット履歴" })).toContainText(
      "将棋4人接続確認",
    );
    await pages[1]!.reload();
    await expect(
      pages[1]!.getByTestId("player-card").filter({ hasText: "将棋接続2" }),
    ).toHaveAttribute("aria-label", "将棋接続2、あなた");
    for (let i = 0; i < 3; i++) {
      snapshot = await readRoom();
      const turnPage = currentPage(snapshot);
      await turnPage.getByRole("button", { name: "投了", exact: true }).click();
      await turnPage
        .getByRole("dialog")
        .getByRole("button", { name: "投了する", exact: true })
        .click();
      await expect
        .poll(async () => {
          const next = await readRoom();
          return next.status === "waiting" ? 4 : next.game.eliminations.length;
        })
        .toBe(i === 2 ? 4 : i + 1);
    }
    snapshot = await readRoom();
    expect(snapshot.lastRound.roundId).toBe(firstRound);
    const replay = await (
      await host.request.get(
        "http://127.0.0.1:8788/api/rooms/" +
          roomId +
          "/rounds/" +
          firstRound +
          "/replay?instanceId=" +
          snapshot.instanceId,
      )
    ).json();
    expect(replay.events).toHaveLength(4);
    await expect(host.getByRole("button", { name: "棋譜を1つ戻る" })).toBeEnabled();
    await expect(host.getByRole("dialog", { name: "対局結果" })).toBeVisible();
    await expect(host.getByRole("dialog", { name: "対局結果" })).toContainText("1位");
    await host.keyboard.press("Escape");
    await host.getByRole("button", { name: "棋譜を1つ戻る" }).click();
    await info.attach("shogi-four-players", {
      body: await host.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    for (const page of pages.slice(1, 4)) {
      await expect(page.getByRole("dialog", { name: "対局結果" })).toBeVisible();
      await page.getByRole("button", { name: "今はしない", exact: true }).click();
    }
    for (const page of pages.slice(0, 4))
      await page.getByRole("button", { name: "準備完了", exact: true }).click();
    await host.getByRole("button", { name: "対局開始", exact: true }).click();
    await expect.poll(async () => (await readRoom()).roundId).not.toBe(firstRound);
    await expect(host.getByRole("button", { name: "棋譜を1つ戻る" })).toHaveCount(0);
    const old = await host.request.get(
      "http://127.0.0.1:8788/api/rooms/" +
        roomId +
        "/rounds/" +
        firstRound +
        "/replay?instanceId=" +
        snapshot.instanceId,
    );
    expect(old.status()).toBe(404);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("将棋のすぐ遊ぶでCPU Lv1とLv2が実際に着手する", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/games/four-shogi");
  await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
  await page.getByRole("textbox", { name: "ニックネーム" }).fill("将棋CPU確認");
  await page.getByRole("button", { name: "CPUとの待機室へ" }).click();
  await expect(page).toHaveURL(/\/rooms\/\d{5}$/);
  await page.getByRole("button", { name: "ルーム設定" }).click();
  const second = page.getByRole("group", { name: "CPU 2のレベル" });
  await second.getByRole("button", { name: "Lv2", exact: true }).click();
  await expect(second.getByRole("button", { name: "Lv2", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "対局開始", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    const source = page
      .getByTestId("shogi-board")
      .getByRole("button", { name: /選択できます/ })
      .first();
    await expect(source).toBeEnabled({ timeout: 60_000 });
    await source.click();
    await page
      .getByTestId("shogi-board")
      .getByRole("button", { name: /移動できます/ })
      .first()
      .click();
    const promotion = page.getByRole("dialog", { name: "成りますか？" });
    if (await promotion.isVisible())
      await promotion.getByRole("button", { name: "成る", exact: true }).click();
  }
  const snapshot = await (await page.request.get("/api" + new URL(page.url()).pathname)).json();
  expect(snapshot.room.game.moveNumber).toBeGreaterThanOrEqual(4);
  await page.getByRole("button", { name: "退室", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "退室する" }).click();
  await expect(page).toHaveURL(/games\/four-shogi$/);
});

for (const game of ["four-reversi", "four-shogi"]) {
  test(game + " 最後の参加者が退室すると観戦者に閉鎖を案内する", async ({ page, browser }) => {
    const context = await browser.newContext({ locale: "ja-JP" });
    try {
      await page.goto("/games/" + game);
      await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
      await page.getByRole("textbox", { name: "ニックネーム" }).fill("閉鎖確認");
      await page.getByRole("button", { name: "CPUとの待機室へ" }).click();
      await expect(page).toHaveURL(/\/rooms\/\d{5}$/);
      const roomURL = page.url();
      await page.getByRole("button", { name: "対局開始", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await (await page.request.get("/api" + new URL(roomURL).pathname)).json()).room.status,
        )
        .toBe("playing");
      const observer = await context.newPage();
      const connected = observer.waitForEvent("websocket");
      await observer.goto(roomURL);
      const socket = await connected;
      await expect(observer.getByText("観戦中です", { exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "メッセージ" }).fill("観戦接続の確認");
      await page.getByRole("button", { name: "送信", exact: true }).click();
      await expect(observer.getByRole("list", { name: "チャット履歴" })).toContainText(
        "観戦接続の確認",
      );
      await Promise.all([
        socket.waitForEvent("close", { timeout: 35_000 }),
        (async () => {
          await page.getByRole("button", { name: "退室", exact: true }).click();
          await page.getByRole("dialog").getByRole("button", { name: "退室する" }).click();
          await observer.bringToFront();
        })(),
      ]);
      await expect(page).toHaveURL(new RegExp("/games/" + game + "$"));
      expect((await page.request.get("/api" + new URL(roomURL).pathname)).status()).toBe(404);
      await expect(observer.getByRole("alert")).toHaveText(
        "ルームは閉鎖されています。ロビーへ戻ってください。",
      );
      await observer.getByRole("link", { name: "ロビーへ戻る", exact: true }).click();
      await expect(observer).toHaveURL(new RegExp("/games/" + game + "$"));
    } finally {
      await context.close();
    }
  });
}

test("本番アセットの管理画面は本人限定で配信し、直接アクセス・再読み込み・登録一覧を表示する", async ({
  page,
  context,
  request,
}, info) => {
  const denied = await request.get("/admin/users", { maxRedirects: 0 });
  expect(denied.status()).toBe(302);
  expect(denied.headers()["location"]).toBe("http://127.0.0.1:8788/login?destination=admin");
  const unauthorized = await request.get("/api/admin/session");
  expect(unauthorized.status()).toBe(401);
  for (const path of [
    "/%61dmin/index.html",
    "/admin%2Findex.html",
    "/unused%2F..%2Fadmin/index.html",
  ])
    expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(302);
  const token = "local-browser-admin-test-token";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("local-worker-browser-test-only-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  ).toString("base64");
  await context.addCookies([
    {
      name: "tetraboard-2026.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
      url: "http://127.0.0.1:8788",
    },
  ]);
  await page.goto("/admin/games/four-shogi");
  await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /折れ線グラフ/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
  const usersResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/admin/users",
  );
  await page.getByRole("link", { name: "登録ユーザー", exact: true }).click();
  const response = await usersResponse;
  expect(response.status()).toBe(200);
  const users = adminUsersSchema.parse(await response.json());
  expect(users.users.find((user) => user.username === "browser_admin")?.createdAtMs).toBe(
    1790953200000,
  );
  await expect(page.getByRole("table")).toContainText("@browser_admin");
  await expect(page.getByRole("row").filter({ hasText: "@browser_admin" })).toContainText(
    /2026\/10\/0?3/,
  );
  await page.getByRole("link", { name: "全体概要", exact: true }).click();
  await expect(page.getByRole("heading", { name: "全体概要", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("admin.png"), fullPage: true });
  const asset = await page.locator('script[src*="/admin/assets/"]').first().getAttribute("src");
  expect(asset).toBeTruthy();
  expect((await request.get(asset!, { maxRedirects: 0 })).status()).toBe(302);
});
