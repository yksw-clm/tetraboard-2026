import { expect, test, type Page } from "@playwright/test";
import { createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { roomSchema, roomTimeControl, type Room } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";
import { mockLobby, mockRoom, playerIds, playingRoom, waitingRoom } from "./fixtures";
import { finishedShogiRound, playingShogiRoom } from "./fourShogiFixtures";

const returnKey = "tetraboard:registration-return";
const resultDialog = (page: Page) => page.getByRole("dialog", { name: "対局結果", exact: true });
const prompt = (page: Page) => page.getByRole("region", { name: "ユーザー登録のご案内" });

function endedReversi(): Room {
  const initial = createInitialState("doubles");
  const end = eliminateColor(initial, "black");
  if (!end.ok || end.state.status !== "finished") throw new Error("Invalid fixture");
  return roomSchema.parse({
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
        id: "00000000-0000-4000-8000-000000000099",
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
  });
}
function states(game: "four-reversi" | "four-shogi") {
  return {
    playing: game === "four-shogi" ? playingShogiRoom() : playingRoom(),
    ended: game === "four-shogi" ? finishedShogiRound().room : endedReversi(),
  };
}
async function mockGoogle(page: Page) {
  const requests: unknown[] = [];
  await page.route("**/api/auth/sign-in/social", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { url: "https://accounts.google.com/registration-test" } });
  });
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Google認証テスト</p>" }),
  );
  return requests;
}
async function waitForPlayer(page: Page) {
  await expect(page.getByTestId("player-card").filter({ hasText: profile.name })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "投了", exact: true })).toBeEnabled();
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game} 初回終局で案内し、再読み込みと再戦では繰り返さず手動表示できる`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const { playing, ended } = states(game);
    const room = await mockRoom(page, playing);
    await page.goto("/rooms/12345");
    await waitForPlayer(page);
    room.update(ended);
    await expect(resultDialog(page)).toBeVisible();
    await expect(prompt(page)).toContainText("棋譜をマイページに残そう");
    await expect(prompt(page)).toContainText("CPUを含まない対人戦のみ");
    await expect(prompt(page)).toContainText("この部屋の席はゲストのまま");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`registration-result-${game}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await prompt(page).getByRole("button", { name: "今はしない" }).click();
    await expect(resultDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeFocused();
    await page.reload();
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
    await expect(resultDialog(page)).toHaveCount(0);
    room.update(playing);
    await waitForPlayer(page);
    room.update(ended);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
    await expect(resultDialog(page)).toHaveCount(0);
    await page.getByRole("button", { name: "結果", exact: true }).click();
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(resultDialog(page)).toHaveCount(0);
  });

  for (const role of ["spectator", "account", "past-result", "auth-error"] as const) {
    test(`${game} ${role}では登録の自動案内を出さない`, async ({ page }) => {
      const { playing, ended } = states(game);
      const room = await mockRoom(
        page,
        role === "past-result" ? ended : playing,
        role !== "spectator",
      );
      if (role === "account") await mockAccount(page, profile);
      if (role === "auth-error")
        await page.route("**/api/account/session", (route) =>
          route.fulfill({ status: 503, json: {} }),
        );
      await page.goto("/rooms/12345");
      await expect(page.getByTestId("player-card")).toHaveCount(4);
      if (role !== "past-result") room.update(ended);
      await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
      await expect(resultDialog(page)).toHaveCount(0);
    });
  }

  for (const intent of ["create", "quick", "join"] as const) {
    test(`${game} ${intent}の登録後に元の参加画面へ戻り、自動送信しない`, async ({ page }) => {
      await mockLobby(page);
      const googleRequests = await mockGoogle(page);
      const submitted: unknown[] = [];
      await page.route(/\/api\/rooms(?:\/\d{5}\/players)?$/, (route) => {
        if (route.request().method() === "POST") submitted.push(route.request().postDataJSON());
        return route.fulfill({ json: { rooms: [], nextCursor: null } });
      });
      await page.goto(`/games/${game}`);
      const label =
        intent === "create" ? "ルームを作る" : intent === "quick" ? "すぐ遊ぶ" : "ルーム番号で参加";
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("入力した名前");
      if (intent === "join")
        await dialog.getByRole("textbox", { name: "ルーム番号", exact: true }).fill("12345");
      else {
        await dialog.getByText("ダブルス", { exact: true }).click();
        if (game === "four-shogi") await dialog.getByText("OFF", { exact: true }).click();
      }
      if (intent === "quick") await expect(prompt(page)).not.toContainText("ランキング");
      await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
      await expect(page).toHaveURL("https://accounts.google.com/registration-test");
      expect(googleRequests).toEqual([{}]);
      await mockAccount(
        page,
        intent === "create"
          ? { ...profile, name: "", username: null, profileCompleted: false }
          : profile,
      );
      await page.goto(intent === "create" ? "/account/setup" : "/account");
      if (intent === "create") {
        await page.getByRole("textbox", { name: "名前", exact: true }).fill("登録した名前");
        await page.getByRole("textbox", { name: "ID（@ID）" }).fill("registered");
        await page.getByRole("button", { name: "プロフィールを作成", exact: true }).click();
      }
      await expect(page).toHaveURL(new RegExp(`/games/${game}$`));
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("参加するアカウント")).toContainText(
        intent === "create" ? "登録した名前" : profile.name,
      );
      if (intent === "join")
        await expect(page.getByRole("textbox", { name: "ルーム番号", exact: true })).toHaveValue(
          "12345",
        );
      else {
        await expect(page.getByRole("radio", { name: /ダブルス/ })).toBeChecked();
        if (game === "four-shogi")
          await expect(page.getByRole("radio", { name: "OFF", exact: true })).toBeChecked();
      }
      expect(submitted).toEqual([]);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), returnKey)).toBeNull();
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }

  test(`${game} CPUのいる公開ルームから登録し、選んだ部屋へ戻る`, async ({ page }) => {
    await mockLobby(page);
    await page.route(/\/api\/rooms(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          rooms: [
            {
              id: "12345",
              game,
              mode: "singles",
              timeControl: roomTimeControl,
              status: "waiting",
              hostName: "公開ルームのホスト",
              hostAvatarUrl: null,
              humanCount: 1,
              cpuCount: 1,
              capacity: 4,
              openSeats: 2,
              updatedAtMs: Date.now(),
            },
          ],
          nextCursor: null,
        },
      }),
    );
    const submitted: unknown[] = [];
    await page.route("**/api/rooms/12345/players", (route) => {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: {} });
    });
    await mockGoogle(page);
    await page.goto(`/games/${game}`);
    await page.getByRole("button", { name: "ルーム 12345 に参加", exact: true }).click();
    await expect(prompt(page)).not.toContainText("ランキング");
    await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
    await expect(page).toHaveURL("https://accounts.google.com/registration-test");
    await mockAccount(page, profile);
    await page.goto("/account");
    await expect(
      page.getByRole("dialog", { name: "ルーム 12345 に参加", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("参加するアカウント")).toContainText(profile.name);
    expect(submitted).toEqual([]);
  });
}

test("OAuth取消から戻るとゲストの入力と将棋設定を保持し、認証開始失敗はその場で再試行できる", async ({
  page,
}) => {
  await mockLobby(page);
  await page.goto("/games/four-shogi");
  await page.getByRole("button", { name: /^ルームを作る/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("そのままの名前");
  await dialog.getByText("ダブルス", { exact: true }).click();
  await dialog.getByText("OFF", { exact: true }).click();
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 503, json: { message: "認証開始のテストエラー" } }),
  );
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page.getByRole("alert")).toContainText("認証開始のテストエラー");
  await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toHaveValue("そのままの名前");
  await mockGoogle(page);
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  await page.goto("/login?error=oauth");
  await page.getByRole("button", { name: "元の画面へ戻る" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ニックネーム" })).toHaveValue("そのままの名前");
  await expect(page.getByRole("radio", { name: /ダブルス/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: "OFF", exact: true })).toBeChecked();
});

test("招待からの登録は部屋世代を維持して参加ダイアログへ戻り、参加は確定操作を待つ", async ({
  page,
}) => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 3);
  const fixture = await mockRoom(page, room, false);
  await mockGoogle(page);
  const path = `/rooms/12345?invite=${room.instanceId}`;
  let joins = 0;
  await page.route("**/api/rooms/12345/players", (route) => {
    joins++;
    return route.fulfill({ status: 409, json: { error: "room_full" } });
  });
  await page.goto(path);
  await page.getByRole("textbox", { name: "ニックネーム" }).fill("招待の入力");
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  await mockAccount(page, profile);
  await page.goto("/account");
  await expect(page).toHaveURL(`http://127.0.0.1:4173${path}`);
  await expect(page.getByRole("dialog", { name: "ルーム 12345 に参加" })).toBeVisible();
  await expect(page.getByLabel("参加するアカウント")).toBeVisible();
  expect(joins).toBe(0);
  expect(fixture.received.some((m) => m.type === "room.auth")).toBe(false);
});

test("対局後の登録では元のゲスト席を保ち、アカウントへの付け替えや自動参加を行わない", async ({
  page,
}) => {
  const fixture = await mockRoom(page, playingRoom());
  await mockGoogle(page);
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  fixture.update(endedReversi());
  await expect(resultDialog(page)).toBeVisible();
  const tokenBefore = await page.evaluate(() =>
    sessionStorage.getItem("tetraboard:room:12345:membership"),
  );
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  await mockAccount(page, { ...profile, name: "新しいアカウント" });
  await page.goto("/account");
  await expect(page).toHaveURL(/\/rooms\/12345\?invite=/);
  await expect(page.getByTestId("player-card").filter({ hasText: profile.name })).toHaveAttribute(
    "aria-label",
    `${profile.name}、あなた、ホスト`,
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("tetraboard:room:12345:membership")),
  ).toBe(tokenBefore);
  expect(
    fixture.received.filter((m) => m.type === "room.auth").every((m) => m.token === tokenBefore),
  ).toBe(true);
  await expect(resultDialog(page)).toHaveCount(0);
});

test("別ダイアログの後に結果を表示し、次局が始まった場合は保留を破棄する", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () => Promise.reject(new Error("Clipboard unavailable")),
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await mockRoom(page, playingRoom());
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  await page.getByRole("button", { name: "招待リンクをコピー" }).click();
  await expect(page.getByRole("dialog", { name: "招待リンク", exact: true })).toBeVisible();
  fixture.update(endedReversi());
  await expect(resultDialog(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(resultDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => sessionStorage.removeItem("tetraboard:registration-result-shown"));
  await page.reload();
  fixture.update(playingRoom());
  await waitForPlayer(page);
  await page.getByRole("button", { name: "招待リンクをコピー" }).click();
  fixture.update(endedReversi());
  fixture.update(playingRoom());
  await page.keyboard.press("Escape");
  await expect(resultDialog(page)).toHaveCount(0);
});

test("別ダイアログで保留した登録案内は部屋閉鎖で取り消す", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () => Promise.reject(new Error("Clipboard unavailable")),
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await mockRoom(page, playingRoom());
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  await page.getByRole("button", { name: "招待リンクをコピー" }).click();
  await expect(page.getByRole("dialog", { name: "招待リンク", exact: true })).toBeVisible();
  fixture.update(endedReversi());
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  await expect(resultDialog(page)).toHaveCount(0);
  fixture.send({ type: "room.error", error: "not_found" });
  await expect(page.getByRole("alert")).toContainText("ルームは閉鎖されています");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("ヘッダーの登録・ログインから登録すると同じゲームのロビーへ戻る", async ({ page }) => {
  await mockLobby(page);
  await mockGoogle(page);
  await page.goto("/games/four-shogi");
  await page.getByRole("link", { name: "登録・ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登録・ログイン", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Googleで続ける" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  await mockAccount(page, profile);
  await page.goto("/account");
  await expect(page).toHaveURL(/games\/four-shogi$/);
});

test("保存できなくても登録でき、復帰情報がなければマイページを表示する", async ({ page }) => {
  await mockLobby(page);
  await mockGoogle(page);
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "tetraboard:registration-return") throw new Error("Unavailable storage");
      return setItem.call(this, key, value);
    };
  });
  await page.goto("/games/four-reversi");
  await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  await mockAccount(page, profile);
  await page.goto("/account");
  await expect(page.getByTestId("account-profile-card")).toBeVisible();
});

test("壊れた・期限切れ・外部URLの復帰情報は使わずマイページを表示する", async ({ page }) => {
  await mockAccount(page, profile);
  await page.goto("/account");
  for (const kind of ["broken", "expired", "external"] as const) {
    await page.evaluate(
      ({ key, kind }) => {
        const data = {
          path: kind === "external" ? "https://example.com" : "/games/four-shogi",
          createdAt: Date.now() - (kind === "expired" ? 3_600_000 : 0),
          oauthStarted: true,
        };
        sessionStorage.setItem(key, kind === "broken" ? "{invalid" : JSON.stringify(data));
      },
      { key: returnKey, kind },
    );
    await page.reload();
    await expect(page.getByTestId("account-profile-card")).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), returnKey)).toBeNull();
  }
});

test("登録結果の自動表示は両ゲームで共有し、CPU戦では戦績の案内を出さない", async ({ page }) => {
  const playing = playingRoom();
  const ended = endedReversi();
  for (const room of [playing, ended]) {
    const player = room.players[1]!;
    room.players[1] = {
      id: player.id,
      name: "CPU",
      kind: "cpu",
      level: 1,
      ready: true,
      reconnectDeadline: null,
      color: room.status === "playing" ? "white" : null,
    };
  }
  const first = await mockRoom(page, playing);
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  first.update(ended);
  await expect(resultDialog(page)).toBeVisible();
  await expect(prompt(page)).not.toContainText("ランキング");
  await page.keyboard.press("Escape");
  const second = await mockRoom(page, playingShogiRoom());
  await page.reload();
  await waitForPlayer(page);
  second.update(finishedShogiRound().room);
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  await expect(resultDialog(page)).toHaveCount(0);
});

test("保存領域が使えなくても、結果の案内はページ内の再戦で繰り返さない", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "tetraboard:registration-result-shown") throw new Error("Storage unavailable");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "tetraboard:registration-result-shown") throw new Error("Storage unavailable");
      return set.call(this, key, value);
    };
  });
  const fixture = await mockRoom(page, playingRoom());
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  fixture.update(endedReversi());
  await expect(resultDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  fixture.update(playingRoom());
  await waitForPlayer(page);
  fixture.update(endedReversi());
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  await expect(resultDialog(page)).toHaveCount(0);
});

test("認証の取得待ち中に終局しても、結果ダイアログを自動表示しない", async ({ page }) => {
  const fixture = await mockRoom(page, playingRoom());
  let release: (() => void) | undefined;
  await page.route("**/api/account/session", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { user: null } });
  });
  await page.goto("/rooms/12345");
  await waitForPlayer(page);
  await expect.poll(() => Boolean(release)).toBe(true);
  fixture.update(endedReversi());
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  await expect(resultDialog(page)).toHaveCount(0);
  release!();
  await expect(resultDialog(page)).toHaveCount(0);
});

test("登録中に部屋番号が再利用されても、元の世代以外には戻らない", async ({ page }) => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 3);
  const fixture = await mockRoom(page, room, false);
  await mockGoogle(page);
  await page.goto(`/rooms/12345?invite=${room.instanceId}`);
  await prompt(page).getByRole("button", { name: "Googleで登録・ログイン" }).click();
  await expect(page).toHaveURL("https://accounts.google.com/registration-test");
  fixture.update({ ...room, instanceId: "00000000-0000-4000-8000-000000000999" });
  await mockAccount(page, profile);
  await page.goto("/account");
  await expect(page.getByText(/このルームは閉鎖されています/)).toBeVisible();
  await expect(page.getByTestId("player-card")).toHaveCount(0);
});
