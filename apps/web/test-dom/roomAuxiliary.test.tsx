import { expect, test } from "bun:test";
import type { ChatEntry, FourShogiRoom } from "@tetraboard/protocol";
import type { FormEvent } from "react";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { useFourShogiRoomReplay } from "../src/features/room/useFourShogiRoomReplay";
import { useRoundReplay } from "../src/features/room/useRoomReplay";
import { useBoardRotation } from "../src/features/room/useBoardRotation";
import {
  finishedShogiRound,
  initialShogiState,
  playingShogiRoom,
} from "../test/fixtures/fourShogiFixtures";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { membership, waitingRoom } from "../test/fixtures/rooms";
import { act, flush, requests, renderHook } from "./harness";

test("チャットはタブ・resize相当の再描画で下書きを保持し、自己メッセージ確定だけで消す", () => {
  const sent: string[] = [],
    room = waitingRoom();
  const input = {
    room,
    membership,
    remoteError: null as string | null,
    sendChat: (text: string) => {
      sent.push(text);
      return true;
    },
    clearRemoteError: () => {},
    notifications: [] as ChatEntry[],
    messages: [] as ChatEntry[],
    connected: true,
  };
  const h = renderHook(useRoomChat, input);
  const event = { preventDefault() {} } as FormEvent<HTMLFormElement>;
  act(() => h.current.setInput("http://example.test"));
  act(() => h.current.handleSubmit(event));
  expect(sent).toHaveLength(0);
  expect(h.current.error).toContain("URL");
  act(() => h.current.setInput("  下書き  "));
  h.rerender({ ...input });
  expect(h.current.input).toBe("  下書き  ");
  act(() => {
    h.current.handleSubmit(event);
    h.current.handleSubmit(event);
  });
  expect(sent).toEqual(["下書き"]);
  expect(h.current.pending).toBe(true);
  expect(h.current.input).toBe("  下書き  ");
  h.rerender({ ...input, remoteError: "再試行" });
  expect(h.current.pending).toBe(false);
  expect(h.current.input).toBe("  下書き  ");
  h.rerender(input);
  act(() => h.current.handleSubmit(event));
  const message = {
    id: crypto.randomUUID(),
    kind: "player" as const,
    senderId: membership.playerId,
    senderName: "本人",
    text: "下書き",
    sentAtMs: Date.now(),
  };
  h.rerender({ ...input, messages: [message] });
  expect(h.current.input).toBe("");
  expect(h.current.pending).toBe(false);
});
function replayPage() {
  const { room, events } = finishedShogiRound(),
    initial = initialShogiState();
  return {
    instanceId: room.instanceId,
    roundId: room.lastRound!.roundId,
    rulesVersion: 1,
    initial: {
      mode: initial.mode,
      players: initial.players,
      threePlayerAttackProhibited: initial.threePlayerAttackProhibited,
    },
    eventCount: events.length,
    events,
    nextCursor: null,
  };
}
test("直前将棋棋譜は取得失敗の再試行・最終局面・局面選択・次局での破棄を処理", async () => {
  const room = finishedShogiRound().room;
  const h = renderHook(useFourShogiRoomReplay, room as FourShogiRoom);
  expect(h.current.loading).toBe(true);
  requests[0]!.respond({}, 503);
  await flush();
  expect(h.current.frames).toHaveLength(0);
  expect(h.current.error).not.toBeNull();
  act(() => h.current.retry());
  expect(requests[1]!.url).toBe(requests[0]!.url);
  requests[1]!.respond(replayPage());
  await flush();
  expect(h.current.index).toBe(4);
  expect(h.current.frame?.game.status).toBe("finished");
  act(() => h.current.select(0));
  expect(h.current.frame?.label).toBe("開始局面");
  act(() => h.current.select(-1));
  expect(h.current.index).toBe(0);
  expect(requests).toHaveLength(2);
  h.rerender(playingShogiRoom());
  expect(h.current.frames).toHaveLength(0);
  expect(h.current.frame).toBeNull();
});
test("次局開始・unmountは棋譜GETをabortし、遅い取得結果を採用しない", async () => {
  const h = renderHook(useFourShogiRoomReplay, finishedShogiRound().room as FourShogiRoom);
  h.rerender(playingShogiRoom());
  expect(requests[0]!.init.signal?.aborted).toBe(true);
  requests[0]!.respond(replayPage());
  await flush();
  expect(h.current.frames).toHaveLength(0);
  h.rerender(finishedShogiRound().room);
  h.unmount();
  expect(requests[1]!.init.signal?.aborted).toBe(true);
  requests[1]!.respond(replayPage());
  await flush();
});
test("リバーシ直前棋譜は新しい局ごとに最終手へ戻り、回転状態は再描画で保持", () => {
  const match = replayMatch();
  const round = {
    game: match.game,
    players: match.participants.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    replay: match.replay,
  };
  const h = renderHook(useRoundReplay, round);
  expect(h.current.index).toBe(h.current.frames.length - 1);
  act(() => h.current.select(0));
  expect(h.current.index).toBe(0);
  h.rerender({ ...round, replay: { ...round.replay, id: crypto.randomUUID() } });
  expect(h.current.index).toBe(h.current.frames.length - 1);
  const rotation = renderHook(useBoardRotation, undefined);
  act(() => rotation.current.rotate());
  rotation.rerender(undefined);
  expect(rotation.current.rotation).toBe(1);
  act(() => {
    rotation.current.rotate();
    rotation.current.rotate();
    rotation.current.rotate();
  });
  expect(rotation.current.rotation).toBe(0);
});
