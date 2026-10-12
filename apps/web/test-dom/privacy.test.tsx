import { afterEach, expect, test } from "bun:test";
import { act, render, rerender, wrap, flush, requests, press, clock, renderHook } from "./harness";
import { SocialSignInButtons } from "../src/features/account/SocialSignInButtons";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { LegalPage } from "../src/features/privacy/LegalPage";
import { DeletionPage } from "../src/features/privacy/DeletionPage";
import {
  legalAcknowledgement,
  legalDocuments,
  publicRecordNotice,
} from "@tetraboard/protocol/privacy";
import { RegistrationPrompt } from "../src/features/account/RegistrationPrompt";
import { useSocialSignIn } from "../src/features/account/useSocialSignIn";
import { RoomInvitationDialogs } from "../src/features/room/RoomInvitationDialogs";
import { legalVersion } from "@tetraboard/protocol/privacy";
import type { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { profile } from "../test/fixtures/account";

afterEach(() => {
  document.cookie =
    "tetraboard-2026.analytics=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
});
function toggle(input: HTMLInputElement) {
  act(() => input.click());
}
test("同意文言・認証ボタン・文書リンクを順に表示し、チェックなしのボタン操作で続ける", async () => {
  const providers: string[] = [];
  const view = render(
    wrap()(<SocialSignInButtons busy={false} onSignIn={(p) => providers.push(p)} />),
  );
  await flush();
  const node = view.firstElementChild!;
  expect(node.children[0]!.textContent).toBe(legalAcknowledgement);
  expect(node.children[1]!.querySelectorAll("button")).toHaveLength(2);
  expect(node.children[2]!.tagName).toBe("NAV");
  expect(view.querySelector('input[type="checkbox"]')).toBeNull();
  for (const a of view.querySelectorAll("a")) {
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  }
  press(view, "Googleで続ける");
  press(view, "Discordで続ける");
  expect(providers).toEqual(["google", "discord"]);
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
    for (const intent of ["quick", "create", "join"] as const)
      for (const user of [null, profile]) {
        let submitted = 0;
        const view = render(
          wrap(user)(
            <RoomEntryDialog
              game={game}
              intent={intent}
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
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
        expect(document.body.textContent).toContain(legalAcknowledgement);
        const form = document.querySelector("form")!;
        act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        expect(submitted).toBe(1);
        rerender(view, null);
      }
  }
});

test("設定前・未認証で規約全文と連絡先を読め、常時計測の目的と保存期間を読む", async () => {
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

test("全6ゲームの結果登録案内も同じ同意文言・ボタン・リンク配置で操作できる", async () => {
  for (const game of [
    "four-reversi",
    "four-shogi",
    "reversi",
    "shogi",
    "gomoku",
    "four-gomoku",
  ] as const) {
    let provider = "";
    const view = render(
      wrap()(
        <RegistrationPrompt
          game={game}
          result
          humanOnly={false}
          busy={false}
          onRegister={(p) => (provider = p)}
        />,
      ),
    );
    await flush();
    const google = [...view.querySelectorAll("button")].find((b) =>
      b.textContent!.includes("Googleで続ける"),
    )!;
    const group = google.parentElement!,
      notice = group.previousElementSibling!,
      links = group.nextElementSibling!;
    expect(notice.textContent).toBe(legalAcknowledgement);
    expect(links.querySelector('a[href="/terms"]')!.getAttribute("target")).toBe("_blank");
    expect(links.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(view.querySelector('input[type="checkbox"]')).toBeNull();
    press(view, "Googleで続ける");
    expect(provider).toBe("google");
    rerender(view, null);
  }
});

test("登録ボタンの操作で端末の同意保存に依存せず現在版をOAuthへ送る", async () => {
  localStorage.clear();
  const h = renderHook(useSocialSignIn, undefined, wrap());
  act(() => {
    void h.current.start("google");
  });
  await flush();
  const request = requests.find((r) => r.url === "/api/auth/sign-in/social")!;
  expect(new Headers(request.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
  expect(localStorage.getItem("tetraboard:legal-version")).toBeNull();
  request.reject(new Error("開始のテスト"));
  await flush();
  h.unmount();
});

test("招待・観戦からのゲスト参加も説明を示し、同意チェックなしで参加する", async () => {
  let submitted = 0;
  const invitation = {
    dialog: "join",
    name: "ゲスト名",
    busy: false,
    message: null,
    unavailableReason: null,
    setName: () => {},
    close: () => {},
    submit: async () => {
      submitted++;
    },
  } as unknown as ReturnType<typeof useRoomInvitation>;
  const view = render(
    wrap()(
      <RoomInvitationDialogs
        invitation={invitation}
        roomId="12345"
        registrationPath="/rooms/12345"
        humanOnly
      />,
    ),
  );
  await flush();
  expect(document.body.textContent).toContain(publicRecordNotice);
  const form = document.querySelector("form")!;
  const footer = form.querySelector('button[type="submit"]')!;
  expect(form.textContent).toContain(legalAcknowledgement);
  expect(footer.parentElement!.previousElementSibling!.textContent).toBe(legalAcknowledgement);
  expect(form.lastElementChild!.querySelector('a[href="/privacy"]')!.getAttribute("target")).toBe(
    "_blank",
  );
  expect(form.querySelector('input[type="checkbox"]')).toBeNull();
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submitted).toBe(1);
  rerender(view, null);
});
