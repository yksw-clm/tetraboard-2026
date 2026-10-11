import { afterEach, expect, test } from "bun:test";
import { act, render, rerender, wrap, flush, requests, press, clock } from "./harness";
import { SocialSignInButtons } from "../src/features/account/SocialSignInButtons";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { LegalPage } from "../src/features/privacy/LegalPage";
import { DeletionPage } from "../src/features/privacy/DeletionPage";
import { analyticsEnabled, setAnalyticsEnabled } from "../src/analytics/preference";
import { forgetConsent } from "../src/features/privacy/consent";
import {
  legalVersion,
  legalAcknowledgement,
  legalDocuments,
  publicRecordNotice,
  analyticsPreferenceCookie,
} from "@tetraboard/protocol/privacy";
import { profile } from "../test/fixtures/account";

afterEach(() => {
  document.cookie = `${analyticsPreferenceCookie}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  document.cookie =
    "tetraboard-2026.analytics=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
});
function toggle(input: HTMLInputElement) {
  act(() => input.click());
}
test("旧版同意ではOAuthを止め、年齢と規約の確認後に両方式を許可する", async () => {
  localStorage.setItem("tetraboard:legal-version", "old");
  const providers: string[] = [];
  const view = render(
    wrap()(<SocialSignInButtons busy={false} onSignIn={(p) => providers.push(p)} />),
  );
  await flush();
  expect(view.textContent).toContain(legalAcknowledgement);
  expect([...view.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  toggle(view.querySelector("input")!);
  expect(localStorage.getItem("tetraboard:legal-version")).toBe(legalVersion);
  press(view, "Googleで続ける");
  press(view, "Discordで続ける");
  expect(providers).toEqual(["google", "discord"]);
  toggle(view.querySelector("input")!);
  expect([...view.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
});

test("全6ゲーム・ゲストと登録者の参加ダイアログで公開説明と確認を表示する", async () => {
  for (const game of [
    "four-reversi",
    "four-shogi",
    "reversi",
    "shogi",
    "gomoku",
    "four-gomoku",
  ] as const) {
    for (const user of [null, profile]) {
      act(() => forgetConsent());
      let submitted = 0;
      const view = render(
        wrap(user)(
          <RoomEntryDialog
            game={game}
            intent="create"
            name="ゲスト名"
            roomCode=""
            mode="singles"
            cpuLevel={1}
            timeControl={{ mainTimeMs: 300000, byoyomiMs: 30000 }}
            busy={false}
            message={null}
            onNameChange={() => {}}
            onRoomCodeChange={() => {}}
            onModeChange={() => {}}
            onCpuLevelChange={() => {}}
            onTimeControlChange={() => {}}
            onSubmit={() => submitted++}
            onClose={() => {}}
            registrationPath={`/games/${game}`}
          />,
        ),
      );
      await flush();
      expect(document.body.textContent).toContain(publicRecordNotice);
      expect(document.querySelector('a[href="/privacy"]')).not.toBeNull();
      expect(document.querySelector('a[href="/terms"]')).not.toBeNull();
      const form = document.querySelector("form")!;
      act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(submitted).toBe(0);
      const checkbox = [
        ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((i) => i.parentElement?.textContent?.includes("13歳以上"))!;
      toggle(checkbox);
      act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(submitted).toBe(1);
      rerender(view, null);
    }
  }
});

test("設定前・未認証で規約全文と連絡先を読め、計測許可と別に扱う", async () => {
  for (const kind of ["privacy", "terms"] as const) {
    const view = render(wrap({ ...profile, profileCompleted: false })(<LegalPage kind={kind} />));
    await flush();
    for (const [title, text] of legalDocuments[kind].sections) {
      expect(view.textContent).toContain(title);
      expect(view.textContent).toContain(text);
    }
    expect(view.querySelector('a[href="mailto:support@tetraboard.net"]')).not.toBeNull();
    rerender(view, null);
  }
});

test("任意計測の停止は既存Cookieを除去し、新しい許可で識別を再開する", async () => {
  document.cookie = "tetraboard-2026.analytics=12345678-1234-4234-8234-123456789abc; Path=/";
  const disabled = setAnalyticsEnabled(false);
  expect(analyticsEnabled()).toBe(false);
  expect(document.cookie).not.toContain("tetraboard-2026.analytics=");
  expect(requests[0].url).toBe("/api/analytics/choice");
  requests[0].respond(null, 204);
  await disabled;
  const enabled = setAnalyticsEnabled(true);
  expect(analyticsEnabled()).toBe(true);
  requests[1].respond(null, 204);
  await enabled;
  document.cookie = `${analyticsPreferenceCookie}=; Max-Age=0; Path=/`;
});

test("退会は確認なしに送信せず、受付・失敗・完了を区別して復帰できる", async () => {
  const view = render(wrap(profile)(<DeletionPage />));
  await flush();
  requests.find((r) => r.url.endsWith("/confirmation"))!.respond({ verified: true, seated: false });
  await flush();
  const button = [...view.querySelectorAll("button")].find(
    (b) => b.textContent === "アカウントを削除",
  )!;
  expect(button.disabled).toBe(true);
  const confirm = [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) =>
    i.parentElement?.textContent?.includes("削除対象"),
  )!;
  toggle(confirm);
  press(view, "アカウントを削除");
  await flush();
  const submit = requests.find((r) => r.url.endsWith("/confirm"))!;
  expect(JSON.parse(String(submit.init.body))).toEqual({ confirm: true });
  submit.respond({ receipt: "test-receipt", status: "processing" }, 202);
  await flush();
  const check = requests.find((r) => r.url.endsWith("/status"))!;
  check.reject(new Error("一時障害"));
  await flush();
  expect(view.textContent).toContain("削除を受け付けました");
  expect(view.textContent).not.toContain("削除が完了");
  expect(view.textContent).toContain("一時障害");
  clock.advance(10000);
  await flush();
  requests
    .filter((r) => r.url.endsWith("/status"))
    .at(-1)!
    .respond({ status: "complete" });
  await flush();
  expect(view.textContent).toContain("削除が完了しました");
  expect(view.textContent).not.toContain("一時障害");
  press(view, "確認を閉じる");
  expect(sessionStorage.getItem("tetraboard:deletion-receipt")).toBeNull();
});

test("在室中は削除操作を出さず退室後の再確認を案内する", async () => {
  const view = render(wrap(profile)(<DeletionPage />));
  await flush();
  requests.find((r) => r.url.endsWith("/confirmation"))!.respond({ verified: true, seated: true });
  await flush();
  expect(view.textContent).toContain("退室してから削除");
  expect(
    [...view.querySelectorAll("button")].some((b) => b.textContent === "アカウントを削除"),
  ).toBe(false);
});

test("別人での再認証は削除も再認証の開始も止め、手続き取消を提供する", async () => {
  const view = render(wrap(profile)(<DeletionPage />));
  await flush();
  requests
    .find((r) => r.url.endsWith("/confirmation"))!
    .respond({ verified: false, seated: false, changedAccount: true });
  await flush();
  expect(view.textContent).toContain("アカウントが削除対象と異なります");
  const button = [...view.querySelectorAll("button")].find(
    (b) => b.textContent === "登録した方法で再認証",
  )!;
  expect(button.disabled).toBe(true);
  press(view, "削除手続きをやめる");
  await flush();
  const cancel = requests.find((r) => r.url.endsWith("/cancel"))!;
  expect(cancel.init.method).toBe("POST");
  cancel.respond(null, 204);
  await flush();
  expect(requests.some((r) => r.url.endsWith("/confirm"))).toBe(false);
});
