import { expect, test } from "bun:test";
import { useLocation } from "react-router";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { useSocialSignIn } from "../src/features/account/useSocialSignIn";
import { useRegistrationRestore } from "../src/features/account/useRegistrationRestore";
import {
  readRegistrationReturn,
  registrationReturnKey,
} from "../src/features/account/registrationReturn";
import { profile } from "../test/fixtures/account";
import { membership, now, playerIds, token, waitingRoom } from "../test/fixtures/rooms";
import { playingShogiRoom, waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { act, denyStorage, clock, flush, requests, renderHook, wrap } from "./harness";
import type { GameId, Room } from "@tetraboard/protocol";

test("両ゲームの作成・すぐ遊ぶは入力と設定を送り、アカウント名を省略し送信中に再送しない", async () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    requests.length = 0;
    const h = renderHook(
      (g: GameId) => ({ ...useRoomEntry(g), location: useLocation() }),
      game,
      wrap(profile),
    );
    act(() => {
      h.current.setMode("doubles");
      h.current.setTimeControl({ mainTimeMs: 60000, byoyomiMs: 0 });
      h.current.setThreePlayerAttackProhibited(false);
    });
    act(() => {
      void h.current.submitRoom("quick");
      void h.current.submitRoom("quick");
    });
    expect(requests).toHaveLength(1);
    expect(h.current.isSubmitting).toBe("quick");
    requests[0]!.respond({ user: profile });
    await flush();
    const payload = JSON.parse(String(requests[1]!.init.body));
    expect(payload.name).toBeUndefined();
    expect(payload.quickPlay).toBe(true);
    expect(payload.mode).toBe("doubles");
    expect(payload.timeControl).toEqual({ mainTimeMs: 60000, byoyomiMs: 0 });
    if (game === "four-shogi") {
      expect(payload.game).toBe(game);
      expect(payload.threePlayerAttackProhibited).toBe(false);
    } else {
      expect(payload.game).toBeUndefined();
      expect(payload.threePlayerAttackProhibited).toBeUndefined();
    }
    const room = game === "four-shogi" ? waitingShogiRoom() : waitingRoom();
    requests[1]!.respond({ room, membership: { ...membership, token } }, 201);
    await flush();
    expect(h.current.location.pathname).toBe("/rooms/12345");
    expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBe(token);
    h.unmount();
  }
});
test("ログイン失効をゲストへ降格して送らず、取得失敗・重複席エラー時に下書きを保持", async () => {
  const h = renderHook(useRoomEntry, "four-reversi" as const, wrap(profile));
  act(() => {
    h.current.setName("入力");
  });
  act(() => {
    void h.current.submitRoom("create");
  });
  requests[0]!.respond({ user: null });
  await flush();
  expect(requests).toHaveLength(1);
  expect(h.current.message).toContain("有効期限");
  expect(h.current.name).toBe("入力");
  act(() => {
    void h.current.submitRoom("create");
  });
  requests[1]!.respond({}, 503);
  await flush();
  expect(requests).toHaveLength(2);
  act(() => {
    void h.current.submitRoom("create");
  });
  requests[2]!.respond({ user: profile });
  await flush();
  requests[3]!.respond({ error: "account_seated" }, 409);
  await flush();
  expect(h.current.message).toContain("既に");
  expect(h.current.name).toBe("入力");
});
test("無効な部屋番号・保存不能・無効な時間設定は作成や参加を送信しない", async () => {
  const h = renderHook(useRoomEntry, "four-reversi" as const, wrap());
  act(() => {
    void h.current.submitRoom("join", "123");
  });
  expect(requests).toHaveLength(0);
  const failure = denyStorage();
  try {
    act(() => {
      void h.current.submitRoom("create");
    });
    expect(requests).toHaveLength(0);
    expect(h.current.message).toContain("保存できません");
  } finally {
    failure.mockRestore();
  }
  act(() => {
    h.current.setName("ゲスト");
    h.current.setTimeControl({ mainTimeMs: 0, byoyomiMs: 0 });
  });
  act(() => {
    void h.current.submitRoom("create");
  });
  requests[0]!.respond({ user: null });
  await flush();
  expect(requests).toHaveLength(1);
  expect(h.current.name).toBe("ゲスト");
});
test("招待の自動表示はタブ・世代ごとに消費し、対局中・満室・参加済みは消費しない", () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const useInvitationProbe = (p: { room: Room; membership: typeof membership | null }) =>
    useRoomInvitation(p.room, p.membership, true, () => {});
  const h = renderHook(useInvitationProbe, { room, membership: null }, wrap());
  expect(h.current.dialog).toBe("join");
  expect(sessionStorage.getItem(`tetraboard:room:12345:${room.instanceId}:invitation-shown`)).toBe(
    "1",
  );
  act(() => h.current.close());
  expect(h.current.dialog).toBeNull();
  act(() => h.current.openJoin());
  expect(h.current.dialog).toBe("join");
  h.unmount();
  const reload = renderHook(useInvitationProbe, { room, membership: null }, wrap());
  expect(reload.current.dialog).toBeNull();
  reload.unmount();
  const next = renderHook(
    useInvitationProbe,
    { room: { ...room, instanceId: "00000000-0000-4000-8000-000000000011" }, membership: null },
    wrap(),
  );
  expect(next.current.dialog).toBe("join");
  next.unmount();
  sessionStorage.clear();
  for (const [otherRoom, seated] of [
    [playingShogiRoom(), null],
    [waitingRoom(), null],
    [room, membership],
  ] as const) {
    const h = renderHook(useInvitationProbe, { room: otherRoom, membership: seated }, wrap());
    expect(h.current.dialog).toBeNull();
    expect(sessionStorage.length).toBe(0);
    h.unmount();
  }
});
test("招待参加は同世代GET確認後に名前を省略したPOSTを送り、取消・連打をロック", async () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const h = renderHook(
    () => useRoomInvitation(room, null, true, () => {}),
    undefined,
    wrap(profile),
  );
  act(() => {
    void h.current.submit();
    void h.current.submit();
    h.current.close();
  });
  expect(h.current.dialog).toBe("join");
  requests[0]!.respond({ user: profile });
  await flush();
  requests[1]!.respond({
    room,
    presence: { hostPlayerId: playerIds[0], connectedPlayerIds: [] },
    serverNowMs: now,
  });
  await flush();
  expect(requests[2]!.url).toBe("/api/rooms/12345/players");
  expect(JSON.parse(String(requests[2]!.init.body))).toEqual({ instanceId: room.instanceId });
  requests[2]!.respond({ error: "account_seated" }, 409);
  await flush();
  expect(h.current.message).toContain("既に");
  expect(h.current.busy).toBe(false);
});
test("OAuth復帰は入力を保存して失敗後再試行、adminでは通常復帰を捨て同じ宛先を送る", async () => {
  const h = renderHook(useSocialSignIn, undefined);
  const destination = {
    path: "/games/four-shogi",
    entry: {
      intent: "create" as const,
      name: "下書き",
      roomCode: "",
      mode: "singles" as const,
      threePlayerAttackProhibited: false,
    },
  };
  act(() => {
    void h.current.start("google", destination);
    void h.current.start("google", destination);
  });
  expect(requests).toHaveLength(1);
  expect(readRegistrationReturn()?.oauthStarted).toBe(true);
  requests[0]!.respond({ message: "準備中" }, 503);
  await flush();
  expect(h.current.busy).toBe(false);
  expect(readRegistrationReturn()?.entry).toEqual(destination.entry);
  expect(readRegistrationReturn()?.oauthStarted).toBe(false);
  act(() => {
    void h.current.start("google", "admin");
  });
  expect(readRegistrationReturn()).toBeNull();
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
    provider: "google",
    destination: "admin",
  });
  requests[1]!.respond({}, 503);
  await flush();
  act(() => {
    void h.current.start("google", "admin");
  });
  expect(requests[2]!.init.body).toBe(requests[1]!.init.body);
  requests[2]!.respond({ url: "https://evil.test/" });
  await flush();
  expect(h.current.message).toContain("開始できません");
});
test("復帰入力は履歴stateから一度だけ読み、保存不能でもOAuth失敗を扱う", async () => {
  const registrationReturn = {
    path: "/games/four-shogi",
    createdAt: Date.now(),
    oauthStarted: true,
    entry: {
      intent: "quick",
      name: "下書き",
      roomCode: "",
      mode: "doubles",
      threePlayerAttackProhibited: false,
    },
  };
  const h = renderHook(
    () => ({ restored: useRegistrationRestore(), location: useLocation() }),
    undefined,
    wrap(null, { pathname: registrationReturn.path, state: { registrationReturn } }),
  );
  expect(h.current.restored?.entry?.name).toBe("下書き");
  expect(h.current.location.state).toBeNull();
  expect(requests).toHaveLength(0);
  const failure = denyStorage();
  try {
    const signIn = renderHook(useSocialSignIn, undefined);
    act(() => {
      void signIn.current.start("google", { path: "/games/four-reversi" });
    });
    expect(requests).toHaveLength(1);
    requests[0]!.respond({}, 503);
    await flush();
    expect(signIn.current.busy).toBe(false);
  } finally {
    failure.mockRestore();
  }
  expect(sessionStorage.getItem(registrationReturnKey)).toBeNull();
  clock.advance(0);
});

test("Discord開始も下書きを保持し、プロバイダーを送り、失敗後Googleへ切り替えられる", async () => {
  const h = renderHook(useSocialSignIn, undefined);
  const destination = {
    path: `/rooms/12345?invite=${waitingRoom().instanceId}`,
    joinName: "下書き",
  };
  act(() => {
    void h.current.start("discord", destination);
    void h.current.start("google", destination);
  });
  expect(requests).toHaveLength(1);
  expect(h.current.pendingProvider).toBe("discord");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ provider: "discord" });
  requests[0]!.respond({ message: "Discordログインは準備中です。" }, 503);
  await flush();
  expect(h.current.pendingProvider).toBeNull();
  expect(readRegistrationReturn()?.joinName).toBe("下書き");
  act(() => {
    void h.current.start("google", destination);
  });
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ provider: "google" });
  requests[1]!.respond({ url: "https://discord.com/api/oauth2/authorize" });
  await flush();
  expect(h.current.busy).toBe(false);
  expect(h.current.message).toContain("開始できません");
});
