import { expect, test } from "bun:test";
import { LoginPage } from "../src/features/account/AccountPages";
import { render, rerender, wrap, press, requests, flush } from "./harness";

test("ログインは両ゲームのバッジ例とメリットを表示し、Discord失敗でも操作を再開できる", async () => {
  const view = render(wrap(null, "/login")(<LoginPage />));
  expect(view.textContent).toContain("対局の楽しさを、自分のアカウントに。");
  expect(view.textContent).toContain("対人シングルス");
  expect(view.textContent).toContain("四人リバーシ");
  expect(view.textContent).toContain("四人将棋");
  expect(view.querySelectorAll("figure img")).toHaveLength(4);
  expect(view.textContent).toContain("登録せずに遊ぶこともできます。");
  press(view, "Discordで続ける");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ provider: "discord" });
  const buttons = [...view.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("で続ける"),
  );
  expect(buttons.every((button) => button.disabled)).toBe(true);
  requests[0]!.respond({ message: "Discordログインは準備中です。" }, 503);
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
