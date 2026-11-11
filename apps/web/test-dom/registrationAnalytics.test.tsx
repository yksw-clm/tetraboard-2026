import { expect, test } from "bun:test";
import { useLocation } from "react-router";
import { AccountMenu } from "../src/features/account/AccountMenu";
import { LoginPage } from "../src/features/account/AccountPages";
import { act, denyStorage, flush, press, render, requests, wrap } from "./harness";
function Journey() {
  return useLocation().pathname === "/login" ? <LoginPage /> : <AccountMenu lobbyGame="reversi" />;
}

test("登録入口からOAuth再試行まで同じ限定情報を送り、計測失敗でボタンや遷移を止めない", async () => {
  const view = render(wrap(null, "/games/reversi?token=SECRET")(<Journey />));
  const link = [...view.querySelectorAll("a")].find((node) =>
    node.textContent?.includes("登録・ログイン"),
  )!;
  act(() =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })),
  );
  await flush();
  expect(view.textContent).toContain("Googleで続ける");
  const entries = requests.filter((r) => r.url === "/api/analytics/registration");
  expect(entries.length).toBeGreaterThan(0);
  const payload = JSON.parse(String(entries[0]!.init.body));
  expect(payload).toEqual({ id: expect.any(String), entry: "account-menu", game: "reversi" });
  expect(entries.every((r) => JSON.parse(String(r.init.body)).id === payload.id)).toBe(true);
  expect(entries.every((r) => !String(r.init.body).includes("SECRET"))).toBe(true);
  press(view, "Discordで続ける");
  const oauth = requests.find((r) => r.url === "/api/auth/sign-in/social")!;
  expect(JSON.parse(String(oauth.init.body))).toEqual({ provider: "discord", analytics: payload });
  for (const entry of entries) entry.respond(null, 503);
  oauth.respond({ message: "認証を開始できません" }, 503);
  await flush();
  press(view, "Googleで続ける");
  const retry = requests.filter((r) => r.url === "/api/auth/sign-in/social").at(-1)!;
  expect(JSON.parse(String(retry.init.body))).toEqual({ provider: "google", analytics: payload });
  retry.respond({ message: "再試行してください" }, 503);
  await flush();
});

test("端末内へ保存できなくても画面の入口とOAuthを対応させ、管理者ログインは計測へ含めない", async () => {
  const failure = denyStorage();
  try {
    const view = render(wrap(null, "/login")(<LoginPage />));
    const entry = requests.find((r) => r.url === "/api/analytics/registration")!;
    press(view, "Googleで続ける");
    const oauth = requests.find((r) => r.url === "/api/auth/sign-in/social")!;
    expect(JSON.parse(String(oauth.init.body)).analytics).toEqual(
      JSON.parse(String(entry.init.body)),
    );
    oauth.respond({ message: "再試行" }, 503);
    entry.respond(null, 503);
    await flush();
  } finally {
    failure.mockRestore();
  }
  requests.length = 0;
  const admin = render(wrap(null, "/login?destination=admin")(<LoginPage />));
  expect(requests.filter((r) => r.url === "/api/analytics/registration")).toHaveLength(0);
  press(admin, "Googleで続ける");
  const oauth = requests.find((r) => r.url === "/api/auth/sign-in/social")!;
  expect(JSON.parse(String(oauth.init.body))).toEqual({ provider: "google", destination: "admin" });
  oauth.respond({ message: "準備中" }, 503);
  await flush();
});
