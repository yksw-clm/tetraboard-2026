import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { useState, type ReactNode } from "react";
import { avatarPresets, avatarPresetUrl, type AccountProfile } from "@tetraboard/protocol";
import { gameIds, type GameId } from "@tetraboard/protocol/games";
import { AccountContext } from "../src/features/account/useAccount";
import { guestIdentityChangedMessage } from "../src/features/account/guestAccount";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { useRoomEntry, type RoomEntryIntent } from "../src/features/lobby/useRoomEntry";
import { RoomInvitationDialogs } from "../src/features/room/RoomInvitationDialogs";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { profile } from "../test/fixtures/account";
import { waitingRoom, now } from "../test/fixtures/rooms";
import { guestProfile } from "./guestAccountFixtures";
import { act, flush, press, render, requests, rerender, wrap } from "./harness";

beforeEach(() => localStorage.setItem("tetraboard:guest-name", "参加者"));
const imageComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete")!;
const imageWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth")!;
beforeEach(() => {
  // 実画像は読み込まず、画像部品に渡るURLだけを検証します。
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => 256,
  });
});
afterEach(() => {
  Object.defineProperty(HTMLImageElement.prototype, "complete", imageComplete);
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", imageWidth);
});

function Session({
  children,
  initial = null,
}: {
  children: ReactNode;
  initial?: AccountProfile | null;
}) {
  const [user, update] = useState(initial);
  return (
    <AccountContext.Provider
      value={{ user, update, loading: false, error: null, refresh: async () => {} }}
    >
      {children}
    </AccountContext.Provider>
  );
}

function Entry({
  game = "four-reversi",
  intent = "create",
}: {
  game?: GameId;
  intent?: RoomEntryIntent;
}) {
  const entry = useRoomEntry(game);
  return (
    <RoomEntryDialog
      game={game}
      intent={intent}
      name={entry.name}
      roomCode="12345"
      mode={entry.mode}
      cpuLevel={entry.cpuLevel}
      timeControl={entry.timeControl}
      busy={entry.isSubmitting !== null}
      message={entry.message}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onCpuLevelChange={entry.setCpuLevel}
      onTimeControlChange={entry.setTimeControl}
      onSubmit={(preset) => void entry.submitRoom(intent, "12345", undefined, preset)}
      onClose={() => {}}
    />
  );
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}
function shuffle() {
  return dialog().querySelector<HTMLButtonElement>('[aria-label="アイコンをランダムに変更"]')!;
}
function preview() {
  return dialog().querySelector<HTMLImageElement>("img")!.getAttribute("src");
}
function submit() {
  act(() =>
    dialog()
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

async function reachGuestSave(offset = 0) {
  requests[offset]!.respond({ user: null });
  await flush();
  requests[offset + 1]!.respond({ user: null });
  await flush();
  expect(requests[offset + 2]!.url).toBe("/api/account/guest");
  return requests[offset + 2]!;
}

test("初期表示とシャッフルは保存せず、連続して別のプリセットを表示・読み上げ、閉じると下書きを破棄する", async () => {
  const random = spyOn(Math, "random").mockReturnValue(0);
  try {
    const view = render(wrap()(<Entry />));
    await flush();
    expect(preview()).toBe(avatarPresetUrl(avatarPresets[0].id));
    for (let i = 0; i < 8; i++) {
      const previous = preview();
      act(() => shuffle().click());
      expect(preview()).not.toBe(previous);
      expect(dialog().querySelector('[role="status"]')!.textContent).toContain("に変更しました。");
    }
    act(() => shuffle().click());
    expect(preview()).toBe(avatarPresetUrl(avatarPresets[1].id));
    expect(requests).toHaveLength(0);
    rerender(view, null);
    rerender(view, wrap()(<Entry />));
    await flush();
    expect(preview()).toBe(avatarPresetUrl(avatarPresets[0].id));
    expect(requests).toHaveLength(0);
  } finally {
    random.mockRestore();
  }
});

test("全6ゲームの作成・CPU・参加は初期／変更済みアイコンを名前と一緒に保存し、送信中は変更しない", async () => {
  for (const game of gameIds) {
    for (const intent of ["create", "quick", "join"] as const) {
      const offset = requests.length;
      const view = render(wrap()(<Entry game={game} intent={intent} />));
      await flush();
      if (intent !== "quick") act(() => shuffle().click());
      const selected = preview()!;
      submit();
      expect(shuffle().disabled).toBe(true);
      const save = await reachGuestSave(offset);
      expect(JSON.parse(String(save.init.body))).toEqual({
        name: "参加者",
        avatarPresetId: selected.split("/").at(-1),
      });
      save.respond({ message: "保存できません" }, 503);
      await flush();
      expect(preview()).toBe(selected);
      expect(shuffle().disabled).toBe(false);
      expect(requests).toHaveLength(offset + 3);
      rerender(view, null);
    }
  }
});

test("プロフィール保存後にルーム作成が失敗しても保存済みアイコンを表示し、再送でゲストを作り直さない", async () => {
  const view = render(
    wrap()(
      <Session>
        <Entry />
      </Session>,
    ),
  );
  await flush();
  const selected = preview()!;
  const preset = avatarPresets.find((p) => selected === avatarPresetUrl(p.id))!.id;
  submit();
  const save = await reachGuestSave();
  const user = { ...guestProfile("参加者"), avatarPresetId: preset, avatarUrl: selected };
  save.respond(user, 201);
  await flush();
  requests[3]!.respond({ user });
  await flush();
  expect(requests[4]!.url).toBe("/api/rooms");
  requests[4]!.respond({ error: "rate_limited" }, 429);
  await flush();
  expect(preview()).toBe(selected);
  expect(shuffle()).toBeNull();
  submit();
  requests[5]!.respond({ user });
  await flush();
  expect(requests[6]!.url).toBe("/api/rooms");
  expect(requests.filter((r) => r.url === "/api/account/guest")).toHaveLength(1);
  rerender(view, null);
});

test("別タブで先に保存されたプロフィールは上書きせず、表示を更新して再確認後だけ進む", async () => {
  render(
    wrap()(
      <Session>
        <Entry />
      </Session>,
    ),
  );
  await flush();
  submit();
  requests[0]!.respond({ user: null });
  await flush();
  const user = {
    ...guestProfile("先に保存"),
    avatarPresetId: avatarPresets[5].id,
    avatarUrl: avatarPresetUrl(avatarPresets[5].id),
  };
  requests[1]!.respond({ user });
  await flush();
  expect(requests).toHaveLength(2);
  expect(dialog().textContent).toContain(guestIdentityChangedMessage);
  expect(dialog().textContent).toContain(user.name);
  expect(preview()).toBe(user.avatarUrl);
  submit();
  requests[2]!.respond({ user });
  await flush();
  expect(requests[3]!.url).toBe("/api/rooms");
});

test("招待と観戦からの参加も選んだアイコンを保存し、閉じて開き直すと未保存の選択を破棄する", async () => {
  for (const invited of [false, true]) {
    const offset = requests.length;
    function Invitation() {
      const invitation = useRoomInvitation(
        { ...waitingRoom(), players: waitingRoom().players.slice(0, 1) },
        null,
        invited,
        () => {},
      );
      return (
        <>
          <button onClick={invitation.openJoin}>参加を開く</button>
          <RoomInvitationDialogs invitation={invitation} roomId="12345" />
        </>
      );
    }
    const random = spyOn(Math, "random").mockReturnValue(0);
    const view = render(wrap()(<Invitation />));
    try {
      if (!invited) press(view, "参加を開く");
      await flush();
      act(() => shuffle().click());
      const selected = preview();
      press(dialog(), "観戦する");
      await flush();
      press(view, "参加を開く");
      await flush();
      expect(preview()).not.toBe(selected);
      submit();
      requests[offset]!.respond({ user: null });
      await flush();
      requests[offset + 1]!.respond({
        room: waitingRoom(),
        presence: { hostPlayerId: null, connectedPlayerIds: [] },
        serverNowMs: now,
      });
      await flush();
      requests[offset + 2]!.respond({ user: null });
      await flush();
      expect(requests[offset + 3]!.url).toBe("/api/account/guest");
      expect(JSON.parse(String(requests[offset + 3]!.init.body)).avatarPresetId).toBe(
        avatarPresets[0].id,
      );
      requests[offset + 3]!.respond({ message: "失敗" }, 503);
      await flush();
    } finally {
      random.mockRestore();
      rerender(view, null);
    }
  }
});

test("既存ゲストと登録者にはシャッフルを出さず、保存済みのアイコンを表示する", async () => {
  for (const user of [profile, guestProfile()]) {
    const view = render(wrap(user)(<Entry />));
    await flush();
    expect(shuffle()).toBeNull();
    expect(dialog().querySelector("input#nickname")).toBeNull();
    expect(dialog().textContent).toContain(user.name);
    rerender(view, null);
  }
});
