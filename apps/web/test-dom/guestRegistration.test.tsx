import { expect, test } from "bun:test";
import { useLocation, MemoryRouter } from "react-router";
import type { RegistrationStatus, AccountProfile } from "@tetraboard/protocol";
import {
  createGuestRegistration,
  readGuestRegistration,
  cancelGuestRegistration,
  prepareGuestRegistration,
  type GuestRegistration,
} from "../src/features/account/guestRegistration";
import { useResultRegistration } from "../src/features/account/useResultRegistration";
import { GuestRegistrationCompletion } from "../src/features/account/GuestRegistrationCompletion";
import { RegistrationCompletion } from "../src/features/account/RegistrationCompletion";
import { LoginPage } from "../src/features/account/AccountPages";
import { AccountContext } from "../src/features/account/useAccount";
import { saveProfile } from "../src/features/account/accountApi";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../src/shared/roomMembership";
import { finishedShogiRound } from "../test/fixtures/fourShogiFixtures";
import { profile } from "../test/fixtures/account";
import { membership, token } from "../test/fixtures/rooms";
import {
  act,
  clock,
  denyStorage,
  flush,
  press,
  render,
  renderHook,
  requests,
  rerender,
  wrap,
} from "./harness";

function flow(): GuestRegistration {
  const result = createGuestRegistration(finishedShogiRound().room);
  saveRoomMembershipToken(result.roomId, token);
  return result;
}
function status(
  value: GuestRegistration,
  changes: Partial<RegistrationStatus> = {},
): RegistrationStatus {
  return {
    registrationId: value.registrationId,
    roomId: value.roomId,
    instanceId: value.instanceId,
    matchId: value.matchId,
    playerId: membership.playerId,
    holdUntilMs: Date.now() + 600000,
    claimUntilMs: Date.now() + 3600000,
    identity: "ready",
    record: "unclaimed",
    seat: "held",
    ...changes,
  };
}
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

test("開始RPC未確定の手続きも204の取消完了を成功として受け取る", async () => {
  const value = flow();
  const cancelling = cancelGuestRegistration(value);
  requests[0]!.respond(null, 204);
  await expect(cancelling).resolves.toBeNull();
});
async function flushCrypto(expectedRequests = 1) {
  // Web Cryptoのネイティブ処理が返るイベントループも進めます。
  for (let attempt = 0; attempt < 100 && requests.length < expectedRequests; attempt++) {
    await act(async () => {
      await Bun.sleep(1);
    });
    await flush();
  }
}

test("OAuthより前に資格候補を保存し、元の参加資格で局を固定して候補のハッシュだけを送る", async () => {
  const value = flow();
  expect(readGuestRegistration()?.newToken).toBe(value.newToken);
  const prepared = prepareGuestRegistration(value);
  await flushCrypto();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  const payload = JSON.parse(String(requests[0]!.init.body));
  expect(payload).toMatchObject({
    registrationId: value.registrationId,
    instanceId: value.instanceId,
    matchId: value.matchId,
  });
  expect(payload.newTokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(payload.newTokenHash).not.toBe(value.newToken);
  expect(payload.newToken).toBeUndefined();
  requests[0]!.respond(status(value, { identity: "unverified" }));
  await prepared;
  expect(readGuestRegistration()?.holdUntilMs).toBe(Date.now() + 600000);
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
});

test("保存不能ならゲストを維持して登録開始APIもOAuthも送らない", async () => {
  const h = renderHook(useResultRegistration, finishedShogiRound().room, wrap());
  const denied = denyStorage();
  try {
    act(() => {
      void h.current.start("google");
    });
    await flush();
    expect(requests).toHaveLength(0);
    expect(h.current.message).toContain("保存できません");
    expect(h.current.busy).toBe(false);
  } finally {
    denied.mockRestore();
  }
});

test("OAuth開始失敗は席保護を中止し、再試行では新しい登録資格を作る", async () => {
  const value = flow();
  const h = renderHook(useResultRegistration, finishedShogiRound().room, wrap());
  act(() => {
    void h.current.start("discord");
    void h.current.start("google");
  });
  await flushCrypto();
  requests[0]!.respond(status(value, { identity: "unverified" }));
  await flush();
  expect(JSON.parse(String(requests[1]!.init.body))).toMatchObject({
    provider: "discord",
    registration: { registrationId: value.registrationId, secret: value.secret },
  });
  expect(JSON.parse(String(requests[1]!.init.body)).registration.newToken).toBeUndefined();
  requests[1]!.respond({ message: "認証開始失敗" }, 503);
  await flush();
  expect(requests[2]!.url).toEndWith("/cancel");
  requests[2]!.respond(status(value, { identity: "unverified", seat: "cancelled" }));
  await flush();
  expect(readGuestRegistration()).toBeNull();
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  act(() => {
    void h.current.start("google");
  });
  await flushCrypto(4);
  expect(readGuestRegistration()?.registrationId).not.toBe(value.registrationId);
});

test("帰属と席変更を確認してから新しい参加資格を保存し元の世代のルームへ戻る", async () => {
  const value = flow();
  const view = render(
    wrap(
      profile,
      "/account",
    )(
      <>
        <RegistrationCompletion enabled>
          <p>マイページ</p>
        </RegistrationCompletion>
        <Location />
      </>,
    ),
  );
  requests[0]!.respond(status(value));
  await flush();
  expect(requests[1]!.url).toEndWith("/complete");
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  expect(readGuestRegistration()).not.toBeNull();
  requests[1]!.respond(status(value, { record: "pending", seat: "complete" }));
  await flush();
  expect(readRoomMembershipToken(value.roomId)).toBe(value.newToken);
  expect(readGuestRegistration()?.returning).toEqual({
    playerId: membership.playerId,
    record: "pending",
  });
  expect(view.querySelector("output")!.textContent).toBe(
    `/rooms/${value.roomId}?invite=${value.instanceId}`,
  );
});

test("サーバー成功後の保存失敗でも資格を保持し、再試行で同じ席の資格を復元する", async () => {
  const value = flow();
  const view = render(wrap(profile)(<GuestRegistrationCompletion flow={value} />));
  requests[0]!.respond(status(value));
  await flush();
  const denied = denyStorage();
  requests[1]!.respond(status(value, { record: "complete", seat: "complete" }));
  await flush();
  expect(view.textContent).toContain("新しい参加資格を保存できません");
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  denied.mockRestore();
  press(view, "再試行");
  await flush();
  requests[2]!.respond(status(value, { record: "complete", seat: "complete" }));
  await flush();
  requests[3]!.respond(status(value, { record: "complete", seat: "complete" }));
  await flush();
  expect(readRoomMembershipToken(value.roomId)).toBe(value.newToken);
  expect(readGuestRegistration()?.returning).toEqual({
    playerId: membership.playerId,
    record: "complete",
  });
});

test("初回設定前は本人確認を待ち、未設定の別アカウントではフォームと自動完了を止める", async () => {
  const value = flow();
  const user = { ...profile, username: null, profileCompleted: false };
  const view = render(
    wrap(user)(
      <GuestRegistrationCompletion flow={value}>
        <p>設定フォーム</p>
      </GuestRegistrationCompletion>,
    ),
  );
  expect(view.textContent).not.toContain("設定フォーム");
  expect(view.textContent).not.toContain("Googleで続ける");
  requests[0]!.respond(status(value, { identity: "mismatch" }));
  await flush();
  expect(view.textContent).toContain("登録開始時のログイン状態と異なります");
  expect(view.textContent).not.toContain("設定フォーム");
  expect(requests).toHaveLength(1);
});

test("1時間経過後もサーバー確認前に資格候補と受付済み情報を捨てない", () => {
  const value = flow();
  clock.advance(3600001);
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
  expect(readGuestRegistration()?.newToken).toBe(value.newToken);
});

test("席保持期限後の新しい登録開始は記録だけの引継ぎを確認してからOAuthへ進む", async () => {
  const value = flow();
  const h = renderHook(useResultRegistration, finishedShogiRound().room, wrap());
  act(() => {
    void h.current.start("google");
  });
  await flushCrypto();
  requests[0]!.respond(status(value, { identity: "unverified", seat: "expired" }));
  await flush();
  expect(requests).toHaveLength(1);
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  const view = render(wrap()(<GuestRegistrationCompletion flow={value} />));
  requests[1]!.respond(status(value, { identity: "unverified", seat: "expired" }));
  await flush();
  expect(view.textContent).toContain("同じ席への復帰はできません");
  press(view, "Googleで続ける");
  expect(requests[2]!.url).toBe("/api/auth/sign-in/social");
});

test("初回設定から結果に戻っても同じ手続きでOAuthを始め直したり席保護を取消したりしない", async () => {
  const value = flow();
  const h = renderHook(useResultRegistration, finishedShogiRound().room, wrap());
  act(() => {
    void h.current.start("google");
  });
  await flushCrypto();
  requests[0]!.respond(status(value, { identity: "profile_required" }));
  await flush();
  expect(requests).toHaveLength(1);
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
});

test("OAuth取消で戻ったログイン画面から席保護を解除しゲストに戻れる", async () => {
  const value = flow();
  const view = render(
    wrap(
      null,
      "/login?error=access_denied",
    )(
      <>
        <LoginPage />
        <Location />
      </>,
    ),
  );
  requests[0]!.respond(status(value, { identity: "unverified" }));
  await flush();
  press(view, "手続きを中止してルームへ戻る");
  requests[1]!.respond(status(value, { identity: "unverified", seat: "cancelled" }));
  await flush();
  requests[2]!.respond({ user: null });
  await flush();
  expect(readGuestRegistration()).toBeNull();
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  expect(view.querySelector("output")!.textContent).toBe(
    `/rooms/${value.roomId}?invite=${value.instanceId}`,
  );
});

test("確認画面のOAuth開始失敗も席保護を取消し、取消失敗時は資格を保持して再試行できる", async () => {
  const value = flow();
  const view = render(
    wrap()(
      <>
        <GuestRegistrationCompletion flow={value} />
        <Location />
      </>,
    ),
  );
  requests[0]!.respond(status(value, { identity: "unverified" }));
  await flush();
  press(view, "Googleで続ける");
  requests[1]!.respond({ message: "認証を開始できません" }, 503);
  await flush();
  expect(requests[2]!.url).toEndWith("/cancel");
  requests[2]!.respond({ message: "取消を確認できません" }, 503);
  await flush();
  expect(view.textContent).toContain("取消を確認できません");
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  press(view, "手続きを中止してルームへ戻る");
  expect(requests[3]!.url).toEndWith("/cancel");
  requests[3]!.respond(status(value, { identity: "unverified", seat: "cancelled" }));
  await flush();
  requests[4]!.respond({ user: null });
  await flush();
  expect(readGuestRegistration()).toBeNull();
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  expect(view.querySelector("output")!.textContent).toBe(
    `/rooms/${value.roomId}?invite=${value.instanceId}`,
  );
});

test("OAuthエラー復帰時に本人確認済みなら同じ手続きの初回設定へ進める", async () => {
  const value = flow();
  const view = render(
    wrap({ ...profile, profileCompleted: false }, "/login?error=retry")(<LoginPage />),
  );
  requests[0]!.respond(status(value, { identity: "profile_required" }));
  await flush();
  const setup = [...view.querySelectorAll("a")].find(
    (link) => link.textContent === "プロフィールを作成する",
  );
  expect(setup?.getAttribute("href")).toBe("/account/setup");
  expect(view.textContent).not.toContain("Googleで続ける");
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
});

test("参加条件の不一致は終端状態として表示し完了を再送しない", async () => {
  const value = flow();
  const view = render(wrap(profile)(<GuestRegistrationCompletion flow={value} />));
  requests[0]!.respond(status(value, { record: "conflict" }));
  await flush();
  expect(view.textContent).toContain("このアカウントにはこの対局を引き継げません");
  expect(requests).toHaveLength(1);
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
});

test("設定中の取消は当該認証セッションのログアウトを要求し、ゲスト資格を維持する", async () => {
  const value = flow();
  const view = render(
    wrap({ ...profile, profileCompleted: false })(
      <GuestRegistrationCompletion flow={value}>
        <p>設定フォーム</p>
      </GuestRegistrationCompletion>,
    ),
  );
  requests[0]!.respond(status(value, { identity: "profile_required" }));
  await flush();
  expect(view.textContent).toContain("設定フォーム");
  press(view, "登録をやめてゲストに戻る");
  await flush();
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ signOut: true });
  requests[1]!.respond(status(value, { identity: "unverified", seat: "cancelled" }));
  await flush();
  expect(requests[2]!.url).toBe("/api/account/session");
  requests[2]!.respond({ user: null });
  await flush();
  expect(readGuestRegistration()).toBeNull();
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
});

test("初回プロフィール保存にも同じ登録資格を渡す", async () => {
  const value = flow();
  const saving = saveProfile(true, new FormData());
  expect(requests[0]!.init.headers).toEqual({
    "X-Registration-Id": value.registrationId,
    "X-Registration-Secret": value.secret,
  });
  requests[0]!.respond(profile);
  await saving;
});

test("確認中にアカウントが切り替わっても古い成功応答から席を付け替えない", async () => {
  const value = flow();
  const renderFlow = (user: AccountProfile, generation: number) => (
    <MemoryRouter>
      <AccountContext.Provider
        value={{
          user,
          generation,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <GuestRegistrationCompletion flow={value} />
      </AccountContext.Provider>
    </MemoryRouter>
  );
  const view = render(renderFlow(profile, 1));
  requests[0]!.respond(status(value));
  await flush();
  rerender(view, renderFlow({ ...profile, username: "other" }, 2));
  await flush();
  requests[1]!.respond(status(value, { record: "complete", seat: "complete" }));
  requests[2]!.respond(status(value, { identity: "mismatch" }));
  await flush();
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  expect(readGuestRegistration()).not.toBeNull();
  expect(view.textContent).toContain("登録開始時のログイン状態と異なります");
});

test("準備応答を失った手続きは同じIDと資格で準備を再開する", async () => {
  const value = flow();
  const view = render(wrap()(<GuestRegistrationCompletion flow={value} />));
  requests[0]!.respond({ error: "preparing", message: "準備中" }, 503);
  await flushCrypto(2);
  expect(requests[1]!.url).toBe(`/api/rooms/${value.roomId}/registration`);
  expect(JSON.parse(String(requests[1]!.init.body)).registrationId).toBe(value.registrationId);
  requests[1]!.respond(status(value, { identity: "unverified" }));
  await flush();
  expect(view.textContent).toContain("Googleで続ける");
});

test("席競合では更新資格を保存せず、記録の受付と席変更未完了を区別する", async () => {
  const value = flow();
  const view = render(wrap(profile)(<GuestRegistrationCompletion flow={value} />));
  requests[0]!.respond(status(value));
  await flush();
  requests[1]!.respond(status(value, { record: "pending", seat: "conflict" }));
  await flush();
  expect(view.textContent).toContain("別のルームに参加中");
  expect(readRoomMembershipToken(value.roomId)).toBe(token);
  expect(readGuestRegistration()?.registrationId).toBe(value.registrationId);
  expect(requests).toHaveLength(2);
});

test("設定途中の期限切れもゲスト復帰でき、同じ手続きでの再OAuthを案内しない", async () => {
  const value = flow();
  const view = render(
    wrap({ ...profile, profileCompleted: false })(
      <GuestRegistrationCompletion flow={value}>
        <p>設定フォーム</p>
      </GuestRegistrationCompletion>,
    ),
  );
  requests[0]!.respond(
    status(value, { identity: "profile_required", record: "expired", seat: "expired" }),
  );
  await flush();
  expect(view.textContent).not.toContain("設定フォーム");
  expect(view.textContent).not.toContain("Googleで続ける");
  press(view, "登録をやめてゲストに戻る");
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ signOut: true });
});
