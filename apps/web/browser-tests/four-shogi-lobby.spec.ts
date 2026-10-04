import { expect, test, type Page } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
import { mockLobby, widths } from "./fixtures";

const reversiPath = "/games/four-reversi";
const shogiPath = "/games/four-shogi";
const green = "rgb(39, 132, 85)";
const yellow = "rgb(242, 188, 59)";
const brown = "rgb(56, 43, 18)";

// 部屋とランキングのHTTP境界を監視し、将棋から既存のリバーシAPIへ進まないことを確認します。
async function watchGameRequests(page: Page) {
  const requests: string[] = [];
  await page.route(
    /\/api\/(?:rooms(?:\/|\?|$)|games\/four-(?:reversi|shogi)\/rankings)/,
    (route) => {
      requests.push(
        `${route.request().method()} ${new URL(route.request().url()).pathname + new URL(route.request().url()).search}`,
      );
      return route.fallback();
    },
  );
  return requests;
}

async function expectSelectedGame(page: Page, name: string) {
  const navigation = page.getByRole("navigation", { name: "ゲームを選択" });
  await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
}

async function expectLobbySectionOrder(page: Page, width: number) {
  await expect
    .poll(() =>
      page
        .locator("main")
        .getByRole("region")
        .evaluateAll((sections) =>
          sections.map(
            (section) =>
              section.getAttribute("aria-label") ??
              document.getElementById(section.getAttribute("aria-labelledby") ?? "")?.textContent,
          ),
        ),
    )
    .toEqual(
      width <= 767
        ? ["対局を始める", "公開ルーム", "ランキング"]
        : ["対局を始める", "ランキング", "公開ルーム"],
    );
}

test("ゲーム切り替えはURL・履歴と一致し、将棋からリバーシの部屋やランキングを取得しない", async ({
  page,
  browserName,
}) => {
  await mockLobby(page);
  const requests = await watchGameRequests(page);
  await page.goto(shogiPath);
  await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
  await expectSelectedGame(page, "四人将棋");
  await expect(page.getByTestId("lobby-board-preview")).toBeVisible();
  await expect(page.getByTestId("lobby-board-preview").getByTestId("shogi-piece")).toHaveCount(36);
  await expect(page.getByRole("region", { name: "公開ルーム" })).not.toContainText("準備中");
  await expect(page.getByRole("region", { name: "ランキング" })).toBeVisible();
  await expect(page.getByRole("region", { name: "ランキング" })).not.toContainText("準備中");
  await expect(page.getByRole("button", { name: /^ルーム \d{5} / })).toHaveCount(0);
  await page.reload();
  await expectSelectedGame(page, "四人将棋");
  await expect(page.getByTestId("lobby-board-preview").getByTestId("shogi-piece")).toHaveCount(36);
  expect(requests).not.toContain("GET /api/games/four-reversi/rankings");

  const navigation = page.getByRole("navigation", { name: "ゲームを選択" });
  await expect(navigation.getByRole("link")).toHaveText(["四人リバーシ", "四人将棋"]);
  await expect(navigation.getByRole("link", { name: "四人リバーシ", exact: true })).toHaveAttribute(
    "href",
    reversiPath,
  );
  await expect(navigation.getByRole("link", { name: "四人将棋", exact: true })).toHaveAttribute(
    "href",
    shogiPath,
  );
  const reversi = navigation.getByRole("link", { name: "四人リバーシ", exact: true });
  const shogi = navigation.getByRole("link", { name: "四人将棋", exact: true });
  await reversi.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${reversiPath}$`));
  await expectSelectedGame(page, "四人リバーシ");
  await expect(page.getByTestId("lobby-board-preview")).toBeVisible();
  await expect(page.getByTestId("lobby-board-preview").getByTestId("shogi-piece")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "ランキング" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^すぐ遊ぶ/ })).toHaveCSS(
    "background-color",
    green,
  );
  await expect.poll(() => requests).toContain("GET /api/rooms");
  await expect.poll(() => requests).toContain("GET /api/games/four-reversi/rankings");

  await reversi.focus();
  await expect(reversi).toBeFocused();
  // macOSのWebKitはOption-Tabでリンクも含めて順にフォーカスします。
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab",
  );
  await expect(shogi).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${shogiPath}$`));
  await expectSelectedGame(page, "四人将棋");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${reversiPath}$`));
  await expectSelectedGame(page, "四人リバーシ");
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${shogiPath}$`));
  await expectSelectedGame(page, "四人将棋");
  await expect(page.getByTestId("lobby-board-preview").getByTestId("shogi-piece")).toHaveCount(36);
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${reversiPath}$`));
});

test("将棋の初期盤面図はタイトル左に表示し、幅を変えても画像と四方向の駒を保つ", async ({
  page,
}, info) => {
  await mockLobby(page);
  await page.goto(shogiPath);
  const preview = page.getByTestId("lobby-board-preview");
  const title = page.getByRole("heading", { name: "四人将棋", exact: true });
  await expect(preview).toHaveAttribute("aria-hidden", "true");
  await expect(preview.getByTestId("shogi-piece")).toHaveCount(36);
  for (const direction of ["up", "right", "down", "left"]) {
    await expect(preview.locator(`[data-piece-direction="${direction}"]`)).toHaveCount(9);
  }
  expect(
    await preview.evaluate(
      (element) =>
        element.querySelectorAll("button, a, input, select, textarea, [tabindex]").length,
    ),
  ).toBe(0);
  for (const width of [320, 390, 767, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // CSSの幅変更だけでは盤面図の再描画前に進むため、DOMの並べ替えも待ちます。
    await expectLobbySectionOrder(page, width);
    await expect(preview).toBeVisible();
    const boardWidth = width <= 767 ? 56 : 88;
    await expect(preview).toHaveCSS("width", `${boardWidth}px`);
    await expect(preview).toHaveCSS("rotate", "-7deg");
    await expect(preview.getByTestId("shogi-piece")).toHaveCount(36);
    // 幅変更時の再描画後も、盤と駒の画像がデコードできることを確認します。
    await preview
      .locator("img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
      );
    const dimensions = await preview.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      };
    });
    expect(Math.abs(dimensions.height - (boardWidth * 500) / 458)).toBeLessThan(0.1);
    const boardBox = (await preview.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(boardBox.x).toBeGreaterThanOrEqual(0);
    expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(titleBox.x);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(width);
    const helpBox = (await page
      .getByRole("button", { name: "遊び方", exact: true })
      .boundingBox())!;
    if (width <= 767) {
      expect(helpBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      expect(helpBox.y).toBeGreaterThanOrEqual(boardBox.y + boardBox.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await info.attach(`shogi-board-preview-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});

test("将棋ランキングはモードと集計項目を切り替えられ、画面幅を変えても選択を保つ", async ({
  page,
}, info) => {
  await mockLobby(page);
  const requests = await watchGameRequests(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(shogiPath);
  const rankings = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(rankings).not.toContainText("準備中");
  await expect(rankings.getByRole("button", { name: "ランキングを更新" })).toBeEnabled();
  await rankings.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await expect(rankings.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rankings.getByRole("heading", { name: "勝利数", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(rankings.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const more = rankings.getByRole("button", { name: "もっと見る", exact: true });
  await more.click();
  const dialog = page.getByRole("dialog", { name: "ランキング", exact: true });
  await expect(dialog).not.toContainText("準備中");
  await expect(dialog.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "更新", exact: true })).toBeEnabled();
  await dialog.getByRole("tab", { name: "対局数", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "対局数", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "シングルス", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "対局数", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog.getByRole("tab", { name: "優勝数", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "優勝数", exact: true })).toBeVisible();
  // Portal内にも将棋の文字色が適用され、共通の緑テーマへ戻らないことを確認します。
  await expect(dialog.getByRole("heading", { name: "優勝数", exact: true })).toHaveCSS(
    "color",
    "rgb(117, 101, 74)",
  );
  await info.attach("shogi-rankings", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog.getByRole("tab", { name: "シングルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(rankings.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(requests).not.toContain("GET /api/games/four-reversi/rankings");
});

for (const width of [320, 390, 768, 1440]) {
  test(`将棋の入力・設定・遊び方と送信失敗を扱う ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mockLobby(page);
    const requests = await watchGameRequests(page);
    const payloads: unknown[] = [];
    await page.route(/\/api\/rooms(?:\/\d{5}\/players)?$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: "internal_error" } });
    });
    await page.goto(shogiPath);
    const quick = page.getByRole("button", { name: /^すぐ遊ぶ/ });
    await expect(quick).toHaveCSS("background-color", yellow);
    await expect(quick).toHaveCSS("color", brown);
    await expect(page.getByRole("banner").getByText("Board", { exact: true })).toHaveCSS(
      "color",
      green,
    );
    await expect(page.getByRole("banner").getByRole("link", { name: "登録・ログイン" })).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );

    await quick.click();
    const dialog = page.getByRole("dialog", { name: "すぐ遊ぶ", exact: true });
    const nickname = dialog.getByRole("textbox", { name: "ニックネーム" });
    await expect(nickname).toBeFocused();
    await nickname.fill("将棋の名前");
    await dialog.getByText("ダブルス", { exact: true }).click();
    await expect(dialog.getByRole("radio", { name: /ダブルス/ })).toBeChecked();
    const confirm = dialog.getByRole("button", { name: "CPUとの待機室へ", exact: true });
    await expect(confirm).toBeEnabled();
    await expect(confirm).toHaveCSS("background-color", yellow);
    await expect(confirm).toHaveCSS("color", brown);
    await expect(dialog).toContainText("CPU3人と対戦");
    await nickname.press("Enter");
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(payloads[0]).toMatchObject({
      name: "将棋の名前",
      game: "four-shogi",
      mode: "doubles",
      threePlayerAttackProhibited: true,
    });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${shogiPath}$`));
    const close = dialog.getByRole("button", { name: "閉じる", exact: true });
    const box = await close.boundingBox();
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
    await info.attach("shogi-entry", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(quick).toBeFocused();

    await page.getByRole("button", { name: /^ルームを作る/ }).click();
    const create = page.getByRole("dialog", { name: "ルームを作る", exact: true });
    await expect(create.getByRole("textbox", { name: "ニックネーム" })).toHaveValue("将棋の名前");
    await expect(create.getByRole("radio", { name: /ダブルス/ })).toBeChecked();
    await expect(create.getByRole("button", { name: "ルームを作る", exact: true })).toBeEnabled();
    await create.getByRole("button", { name: "閉じる", exact: true }).click();

    await page.getByRole("button", { name: /^ルーム番号で参加/ }).click();
    const join = page.getByRole("dialog", { name: "ルーム番号で参加", exact: true });
    await join.getByRole("textbox", { name: "ルーム番号", exact: true }).fill("12345");
    await expect(join.getByRole("textbox", { name: "ルーム番号", exact: true })).toHaveValue(
      "12345",
    );
    await expect(join.getByRole("button", { name: "参加する", exact: true })).toBeEnabled();
    await join.getByRole("textbox", { name: "ルーム番号", exact: true }).press("Enter");
    await expect(join.getByRole("alert")).toBeVisible();
    await expect(join.getByRole("button", { name: "参加する", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(join).toHaveCount(0);

    const help = page.getByRole("button", { name: "遊び方", exact: true });
    await help.click();
    const rules = page.getByRole("dialog", { name: "四人将棋の遊び方", exact: true });
    await expect(rules).toContainText("三人攻撃");
    await expect(rules).toContainText("初期値はON");
    await expect(rules).not.toContainText("オンライン対局は準備中");
    await expect(rules).not.toContainText("石数");
    const understood = rules.getByRole("button", { name: "わかった", exact: true });
    await expect(understood).toHaveCSS("background-color", yellow);
    await info.attach("shogi-rules", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await understood.click();
    await expect(help).toBeFocused();
    expect(requests).not.toContain("GET /api/games/four-reversi/rankings");

    await page
      .getByRole("navigation", { name: "ゲームを選択" })
      .getByRole("link", { name: "四人リバーシ", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "四人リバーシ", exact: true })).toBeVisible();
    await expectSelectedGame(page, "四人リバーシ");
    await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
    const reversi = page.getByRole("dialog", { name: "すぐ遊ぶ", exact: true });
    await expect(reversi.getByRole("textbox", { name: "ニックネーム" })).toHaveValue("");
    await expect(reversi.getByRole("radio", { name: /シングルス/ })).toBeChecked();
    await expect(reversi.getByRole("button", { name: "CPUとの待機室へ" })).toHaveCSS(
      "background-color",
      green,
    );
    await page.keyboard.press("Escape");
    requests.length = 0;
    await page
      .getByRole("navigation", { name: "ゲームを選択" })
      .getByRole("link", { name: "四人将棋", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
    await expectSelectedGame(page, "四人将棋");
    await quick.click();
    await expect(nickname).toHaveValue("");
    await expect(dialog.getByRole("radio", { name: /シングルス/ })).toBeChecked();
    expect(requests).not.toContain("GET /api/games/four-reversi/rankings");
  });
}

test("将棋でもログイン済みのプロフィールを確認でき、アカウント画面とメニューは共通テーマを保つ", async ({
  page,
}) => {
  await mockLobby(page);
  await mockAccount(page, profile);
  const requests = await watchGameRequests(page);
  await page.goto(shogiPath);
  await page.getByRole("button", { name: /^ルームを作る/ }).click();
  const entry = page.getByRole("dialog", { name: "ルームを作る", exact: true });
  await expect(entry.getByLabel("参加するアカウント")).toContainText(profile.name);
  await expect(entry.getByRole("textbox", { name: "ニックネーム" })).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "ルームを作る", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  expect(requests).not.toContain("GET /api/games/four-reversi/rankings");
  const menu = page.getByRole("button", { name: /のアカウントメニュー/ });
  await menu.focus();
  await page.keyboard.press("Enter");
  const myPage = page.getByRole("menuitem", { name: "マイページ", exact: true });
  await myPage.focus();
  await expect(myPage).toHaveCSS("background-color", "rgb(231, 238, 234)");
  await myPage.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("navigation", { name: "ゲームを選択" })).toHaveCount(0);
  await page.getByRole("button", { name: "プロフィールを編集", exact: true }).click();
  const profileDialog = page.getByRole("dialog", { name: "プロフィールを編集", exact: true });
  await expect(profileDialog.getByRole("button", { name: "保存", exact: true })).toHaveCSS(
    "background-color",
    green,
  );
});

test("両ゲームの切り替えはスマートフォンでも2項目が収まり、ヘッダーの直下に表示する", async ({
  page,
}, info) => {
  await mockLobby(page);
  for (const path of [reversiPath, shogiPath]) {
    await page.goto(path);
    await expectSelectedGame(page, path === shogiPath ? "四人将棋" : "四人リバーシ");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const navigation = page.getByRole("navigation", { name: "ゲームを選択" });
      const header = (await page.getByRole("banner").boundingBox())!;
      const nav = (await navigation.boundingBox())!;
      const links = await navigation.getByRole("link").all();
      expect(links).toHaveLength(2);
      const [left, right] = await Promise.all(links.map((link) => link.boundingBox()));
      expect(nav.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
      expect(left!.height).toBeGreaterThanOrEqual(44);
      expect(right!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(1);
      expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width - 1);
      if (width <= 650) expect(Math.abs(left!.width - right!.width)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const play = page.getByRole("region", { name: "対局を始める", exact: true });
      const rankings = page.getByRole("region", { name: "ランキング", exact: true });
      const rooms = page.getByRole("region", { name: "公開ルーム", exact: true });
      await expectLobbySectionOrder(page, width);
      const [playBox, rankingsBox, roomsBox] = await Promise.all([
        play.boundingBox(),
        rankings.boundingBox(),
        rooms.boundingBox(),
      ]);
      const closeTo = (actual: number, expected: number) =>
        expect(Math.abs(actual - expected), `${path} ${width}px`).toBeLessThanOrEqual(1);
      if (width >= 768) {
        closeTo(playBox!.width, rankingsBox!.width);
        closeTo(playBox!.y, rankingsBox!.y);
        closeTo(roomsBox!.x, playBox!.x);
        closeTo(roomsBox!.x + roomsBox!.width, rankingsBox!.x + rankingsBox!.width);
        expect(roomsBox!.y).toBeGreaterThanOrEqual(playBox!.y + playBox!.height);
        expect(roomsBox!.y).toBeGreaterThanOrEqual(rankingsBox!.y + rankingsBox!.height);
      } else {
        closeTo(roomsBox!.width, playBox!.width);
        closeTo(rankingsBox!.width, playBox!.width);
        expect(roomsBox!.y).toBeGreaterThanOrEqual(playBox!.y + playBox!.height);
        expect(rankingsBox!.y).toBeGreaterThanOrEqual(roomsBox!.y + roomsBox!.height);
      }
      if ([320, 390, 768, 1440].includes(width))
        await info.attach(`${path.split("/").at(-1)}-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
    }
  }
});
