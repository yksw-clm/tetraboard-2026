import { legalVersion } from "@tetraboard/protocol/privacy";
import { expect, test } from "bun:test";
import { useLocation } from "react-router";
import { type GameId, type Room } from "@tetraboard/protocol";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { RoomInvitationDialogs } from "../src/features/room/RoomInvitationDialogs";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { profile } from "../test/fixtures/account";
import { membership, now, token, waitingRoom } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import {
  act,
  denyStorage,
  enter,
  flush,
  render,
  renderHook,
  requests,
  rerender,
  wrap,
} from "./harness";

const storageKey = "tetraboard:guest-name";
const games = ["four-reversi", "four-shogi"] as const;
function roomFor(game: GameId): Room {
  return game === "four-shogi" ? waitingShogiRoom() : waitingRoom();
}
function snapshot(room: Room) {
  return {
    room,
    presence: { hostPlayerId: membership.playerId, connectedPlayerIds: [] },
    serverNowMs: now,
  };
}

test("両ゲームの作成・すぐ遊ぶ・番号／公開一覧のダイアログに保存名を表示し編集できる", async () => {
  localStorage.setItem(storageKey, "保存名");
  for (const game of games) {
    for (const entry of [
      { intent: "create" },
      { intent: "quick" },
      { intent: "join" },
      { intent: "join", selectedRoomId: "12345" },
    ] as const) {
      function Probe() {
        const h = useRoomEntry(game);
        return (
          <RoomEntryDialog
            {...entry}
            name={h.name}
            roomCode={h.roomCode}
            mode={h.mode}
            timeControl={h.timeControl}
            onTimeControlChange={h.setTimeControl}
            busy={false}
            message={null}
            onNameChange={h.setName}
            onRoomCodeChange={h.setRoomCode}
            onModeChange={h.setMode}
            cpuLevel={h.cpuLevel}
            onCpuLevelChange={h.setCpuLevel}
            onSubmit={() => {}}
            onClose={() => {}}
          />
        );
      }
      const view = render(wrap()(<Probe />));
      await flush();
      const input = document.querySelector<HTMLInputElement>("#nickname")!;
      expect(input.value).toBe("保存名");
      enter(input, "編集名");
      expect(input.value).toBe("編集名");
      expect(localStorage.getItem(storageKey)).toBe("保存名");
      rerender(view, null);
    }
  }
});

test("両ゲームの招待・ルーム内参加に保存名を表示し、編集と取消では保存名を変更しない", async () => {
  localStorage.setItem(storageKey, "保存名");
  for (const game of games) {
    const room = roomFor(game);
    room.players = room.players.slice(0, 1);
    for (const invited of [true, false]) {
      const h = renderHook(
        () => useRoomInvitation(room, null, invited, () => {}),
        undefined,
        wrap(),
      );
      if (!invited) act(() => h.current.openJoin());
      const view = render(
        wrap()(<RoomInvitationDialogs invitation={h.current} roomId={room.id} />),
      );
      await flush();
      expect(document.querySelector<HTMLInputElement>("input:not([type=checkbox])")!.value).toBe(
        "保存名",
      );
      act(() => {
        h.current.setName("編集中");
        h.current.close();
        h.current.openJoin();
      });
      expect(h.current.name).toBe("編集中");
      expect(localStorage.getItem(storageKey)).toBe("保存名");
      expect(requests).toHaveLength(0);
      rerender(view, null);
      h.unmount();
    }
    sessionStorage.clear();
  }
});

test("ゲストの作成・すぐ遊ぶ・番号／一覧参加の成功後だけ送信名を保存し別ゲームで復元する", async () => {
  for (const game of games) {
    for (const entry of [
      { intent: "create" },
      { intent: "quick" },
      { intent: "join" },
      { intent: "join", selectedRoomId: "12345" },
    ] as const) {
      requests.length = 0;
      sessionStorage.clear();
      localStorage.setItem(storageKey, "前の名前");
      const h = renderHook(
        () => ({ ...useRoomEntry(game), location: useLocation() }),
        undefined,
        wrap(),
      );
      act(() => {
        h.current.setName("  新しい名前  ");
        h.current.setRoomCode("12345");
      });
      act(() => {
        void h.current.submitRoom(
          entry.intent,
          "selectedRoomId" in entry ? entry.selectedRoomId : undefined,
        );
      });
      requests[0]!.respond({ user: null });
      await flush();
      expect(JSON.parse(String(requests[1]!.init.body)).name).toBe("新しい名前");
      expect(localStorage.getItem(storageKey)).toBe("前の名前");
      // 送信後に下書きが変わっても、実際に送った名前を記録する。
      act(() => h.current.setName("送信後の入力"));
      requests[1]!.respond(
        {
          room: roomFor(game),
          membership: { ...membership, role: entry.intent === "join" ? "player" : "host", token },
        },
        entry.intent === "join" ? 200 : 201,
      );
      await flush();
      expect(h.current.location.pathname).toBe("/rooms/12345");
      expect(localStorage.getItem(storageKey)).toBe("新しい名前");
      h.unmount();
      const next = renderHook(
        useRoomEntry,
        game === "four-shogi" ? "four-reversi" : "four-shogi",
        wrap(),
      );
      expect(next.current.name).toBe("新しい名前");
      next.unmount();
    }
  }
});

test("招待・ルーム内参加の成功後も正規化したゲスト名をロビーへ引き継ぐ", async () => {
  for (const game of games) {
    for (const invited of [true, false]) {
      requests.length = 0;
      sessionStorage.clear();
      localStorage.setItem(storageKey, "前の名前");
      const room = roomFor(game);
      room.players = room.players.slice(0, 1);
      const h = renderHook(
        () => ({ ...useRoomInvitation(room, null, invited, () => {}), location: useLocation() }),
        undefined,
        wrap(),
      );
      if (!invited) act(() => h.current.openJoin());
      act(() => h.current.setName("  招待の名前  "));
      act(() => {
        void h.current.submit();
      });
      requests[0]!.respond({ user: null });
      await flush();
      requests[1]!.respond(snapshot(room));
      await flush();
      expect(new Headers(requests[2]!.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
      expect(JSON.parse(String(requests[2]!.init.body))).toEqual({
        name: "招待の名前",
        instanceId: room.instanceId,
      });
      expect(localStorage.getItem(storageKey)).toBe("前の名前");
      requests[2]!.respond({ room, membership: { ...membership, role: "player", token } });
      await flush();
      expect(h.current.location.pathname).toBe("/rooms/12345");
      expect(localStorage.getItem(storageKey)).toBe("招待の名前");
      h.unmount();
      const next = renderHook(useRoomEntry, game, wrap());
      expect(next.current.name).toBe("招待の名前");
      next.unmount();
    }
  }
});

test("登録復帰の下書きは空文字も含めて保存名より優先する", () => {
  localStorage.setItem(storageKey, "保存名");
  for (const name of ["下書き", ""]) {
    for (const game of games) {
      const path = `/games/${game}`;
      const h = renderHook(
        useRoomEntry,
        game,
        wrap(null, {
          pathname: path,
          state: {
            registrationReturn: {
              path,
              createdAt: Date.now(),
              oauthStarted: true,
              entry: { intent: "create", name, roomCode: "", mode: "singles" },
            },
          },
        }),
      );
      expect(h.current.name).toBe(name);
      h.unmount();
      const room = roomFor(game);
      const roomPath = `/rooms/${room.id}?invite=${room.instanceId}`;
      const invitation = renderHook(
        () => useRoomInvitation(room, null, false, () => {}),
        undefined,
        wrap(null, {
          pathname: roomPath,
          state: {
            registrationReturn: {
              path: roomPath,
              createdAt: Date.now(),
              oauthStarted: true,
              joinName: name,
            },
          },
        }),
      );
      expect(invitation.current.name).toBe(name);
      invitation.unmount();
    }
  }
  expect(localStorage.getItem(storageKey)).toBe("保存名");
});

test("別タブ相当の保存変更は編集中の画面に反映せず再表示時に読み直す", () => {
  localStorage.setItem(storageKey, "最初の名前");
  const room = waitingRoom();
  const h = renderHook(useRoomEntry, "four-reversi", wrap());
  const invitation = renderHook(
    () => useRoomInvitation(room, null, false, () => {}),
    undefined,
    wrap(),
  );
  act(() => {
    h.current.setName("");
    invitation.current.setName("編集中");
  });
  localStorage.setItem(storageKey, "別タブの名前");
  h.rerender("four-reversi");
  act(() => invitation.current.openJoin());
  expect(h.current.name).toBe("");
  expect(invitation.current.name).toBe("編集中");
  h.unmount();
  invitation.unmount();
  const next = renderHook(useRoomEntry, "four-reversi", wrap());
  const nextInvitation = renderHook(
    () => useRoomInvitation(room, null, false, () => {}),
    undefined,
    wrap(),
  );
  expect(next.current.name).toBe("別タブの名前");
  expect(nextInvitation.current.name).toBe("別タブの名前");
});

test("作成・参加の通信失敗・拒否・不正応答・資格保存失敗では以前の保存名を保つ", async () => {
  for (const intent of ["create", "join"] as const) {
    for (const failure of [
      "network",
      "full",
      "invalid",
      "membership",
      "missing-player",
      "storage",
    ] as const) {
      requests.length = 0;
      sessionStorage.clear();
      localStorage.setItem(storageKey, "前の名前");
      const h = renderHook(useRoomEntry, "four-reversi", wrap());
      act(() => h.current.setName("変更した名前"));
      act(() => {
        void h.current.submitRoom(intent, "12345");
      });
      requests[0]!.respond({ user: null });
      await flush();
      const blocked = failure === "storage" ? denyStorage() : null;
      try {
        if (failure === "network") requests[1]!.reject(new Error("offline"));
        else if (failure === "full") requests[1]!.respond({ error: "room_full" }, 409);
        else if (failure === "invalid") requests[1]!.respond({}, intent === "create" ? 201 : 200);
        else
          requests[1]!.respond(
            {
              room: waitingRoom(),
              membership: {
                ...membership,
                playerId:
                  failure === "missing-player"
                    ? "00000000-0000-4000-8000-000000000099"
                    : membership.playerId,
                role:
                  failure === "membership"
                    ? intent === "create"
                      ? "player"
                      : "host"
                    : intent === "create"
                      ? "host"
                      : "player",
                token,
              },
            },
            intent === "create" ? 201 : 200,
          );
        await flush();
        expect(h.current.message).not.toBeNull();
        expect(localStorage.getItem(storageKey)).toBe("前の名前");
        expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBeNull();
      } finally {
        blocked?.mockRestore();
        h.unmount();
      }
    }
  }
});

test("既存参加資格での復帰では入力名を保存しない", async () => {
  localStorage.setItem(storageKey, "前の名前");
  sessionStorage.setItem("tetraboard:room:12345:membership", token);
  const h = renderHook(useRoomEntry, "four-reversi", wrap());
  act(() => h.current.setName("別の入力"));
  act(() => {
    void h.current.submitRoom("join", "12345");
  });
  requests[0]!.respond({ user: null });
  await flush();
  requests[1]!.respond(membership);
  await flush();
  expect(requests).toHaveLength(2);
  expect(localStorage.getItem(storageKey)).toBe("前の名前");
});

test("アカウントの作成・参加では名前を送信せず保存済みゲスト名を維持する", async () => {
  for (const intent of ["create", "join"] as const) {
    requests.length = 0;
    sessionStorage.clear();
    localStorage.setItem(storageKey, "ゲスト名");
    const h = renderHook(useRoomEntry, "four-reversi", wrap(profile));
    act(() => {
      void h.current.submitRoom(intent, "12345");
    });
    requests[0]!.respond({ user: profile });
    await flush();
    expect(JSON.parse(String(requests[1]!.init.body)).name).toBeUndefined();
    requests[1]!.respond(
      {
        room: waitingRoom(),
        membership: {
          ...membership,
          role: intent === "create" ? "host" : "player",
          token,
        },
      },
      intent === "create" ? 201 : 200,
    );
    await flush();
    expect(h.current.message).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe("ゲスト名");
    h.unmount();
  }
});

test("名前の保存領域が読取り／書込み不能でもゲストの作成・参加を完了する", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("denied");
    },
  });
  try {
    for (const intent of ["create", "join"] as const) {
      requests.length = 0;
      sessionStorage.clear();
      const h = renderHook(
        () => ({ ...useRoomEntry(), location: useLocation() }),
        undefined,
        wrap(),
      );
      expect(h.current.name).toBe("");
      act(() => h.current.setName("使う名前"));
      act(() => {
        void h.current.submitRoom(intent, "12345");
      });
      requests[0]!.respond({ user: null });
      await flush();
      expect(new Headers(requests[1]!.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
      requests[1]!.respond(
        {
          room: waitingRoom(),
          membership: {
            ...membership,
            role: intent === "create" ? "host" : "player",
            token,
          },
        },
        intent === "create" ? 201 : 200,
      );
      await flush();
      expect(h.current.location.pathname).toBe("/rooms/12345");
      expect(h.current.message).toBeNull();
      expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBe(token);
      h.unmount();
    }
    const invitation = renderHook(
      () => useRoomInvitation(waitingRoom(), null, false, () => {}),
      undefined,
      wrap(),
    );
    expect(invitation.current.name).toBe("");
  } finally {
    Object.defineProperty(globalThis, "localStorage", original);
  }
});
