import { expect, test } from "bun:test";
import { LoginPage } from "../src/features/account/AccountPages";
import { render, rerender, wrap, press, requests, flush } from "./harness";

test("ログインは両ゲームのバッジ例とメリットを表示し、Discord失敗でも操作を再開できる", async () => {
  const view = render(wrap(null, "/login")(<LoginPage />));
  expect(view.textContent).not.toContain("対局の楽しさを、自分のアカウントに。");
  const badges = [...view.querySelectorAll("li")].find(
    (item) => item.querySelector("strong")?.textContent === "バッジを集めよう",
  )!;
  expect(badges.textContent).toContain("シングルスの対人戦やレート戦");
  expect(badges.textContent).toContain("四人リバーシ");
  expect(badges.textContent).toContain("四人将棋");
  expect(badges.querySelectorAll("figure img")).toHaveLength(4);
  expect(view.textContent).toContain("登録せずに遊ぶこともできます。");
  const entry = requests.find((request) => request.url === "/api/analytics/registration")!;
  const context = JSON.parse(String(entry.init.body));
  expect(context).toEqual({ id: expect.any(String), entry: "login-page", game: null });
  entry.respond(null, 204);
  press(view, "Discordで続ける");
  const oauth = requests.find((request) => request.url === "/api/auth/sign-in/social")!;
  expect(JSON.parse(String(oauth.init.body))).toEqual({ provider: "discord", analytics: context });
  const buttons = [...view.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("で続ける"),
  );
  expect(buttons.every((button) => button.disabled)).toBe(true);
  oauth.respond({ message: "Discordログインは準備中です。" }, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')!.textContent).toContain("準備中");
  expect(buttons.every((button) => !button.disabled)).toBe(true);
});

test("OAuthエラーを日本語で説明し、管理画面向けにはGoogleだけを表示する", () => {
  for (const [error, message] of [
    ["email_not_found", "メールアドレスを取得できません"],
    ["account_not_linked", "最初に登録した方法"],
  ] as const) {
    const view = render(wrap(null, `/login?error=${error}`)(<LoginPage />));
    expect(view.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(view.textContent).toContain("Googleで続ける");
    rerender(view, null);
  }
  const admin = render(wrap(null, "/login?destination=admin")(<LoginPage />));
  expect(admin.textContent).toContain("管理画面へログイン");
  expect(admin.textContent).toContain("Googleで続ける");
  expect(admin.textContent).not.toContain("Discordで続ける");
  expect(admin.textContent).not.toContain("バッジを集めよう");
  expect(admin.querySelectorAll("figure")).toHaveLength(0);
});
