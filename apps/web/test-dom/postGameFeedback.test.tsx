import { expect, test } from "bun:test";
import { StrictMode } from "react";
import type { Room, RoomMembership } from "@tetraboard/protocol";
import { PostGameFeedbackDialog } from "../src/features/feedback/PostGameFeedbackDialog";
import {
  usePostGameFeedback,
  postGameFeedbackShownKey,
} from "../src/features/feedback/usePostGameFeedback";
import { finishedShogiRound } from "../test/fixtures/fourShogiFixtures";
import { membership } from "../test/fixtures/rooms";
import { act, enter, flush, press, render, renderHook, requests } from "./support";

const ended = () => finishedShogiRound().room;
type Input = {
  room: Room;
  member: RoomMembership | null;
  authenticated: boolean;
  ready: boolean;
  loggedIn: boolean;
};
const input = (): Input => ({
  room: ended(),
  member: membership,
  authenticated: true,
  ready: true,
  loggedIn: false,
});
const useProbe = (p: Input) =>
  usePostGameFeedback(p.room, p.member, p.authenticated, p.ready, p.loggedIn);

test("表示時にブラウザへ記録し、閉じる・再描画・再戦・再マウント・ログイン後も再表示しない", () => {
  const h = renderHook(useProbe, input(), (child) => <StrictMode>{child}</StrictMode>);
  expect(localStorage.getItem(postGameFeedbackShownKey)).toBeNull();
  act(() => expect(h.current.open()).toBe(true));
  expect(h.current.context).toMatchObject({
    game: "four-shogi",
    opponent: "human",
    accountRequired: false,
  });
  expect(localStorage.getItem(postGameFeedbackShownKey)).toBe("1");
  act(() => h.current.close());
  h.rerender({ ...input(), loggedIn: true });
  act(() => expect(h.current.open()).toBe(false));
  h.unmount();
  const other = renderHook(useProbe, input());
  act(() => expect(other.current.open()).toBe(false));
});

test("観戦・本人不在・認証未確認・接続切れ・進行中は表示済みにしない", () => {
  for (const change of [
    { member: null },
    { member: { ...membership, playerId: crypto.randomUUID() } },
    { authenticated: false },
    { ready: false },
    { room: { ...ended(), lastRound: null } as Room },
  ]) {
    const h = renderHook(useProbe, { ...input(), ...change });
    act(() => expect(h.current.open()).toBe(false));
    expect(localStorage.getItem(postGameFeedbackShownKey)).toBeNull();
    h.unmount();
  }
});

test("前局のCPU参加を使い、現在席からCPUが消えていてもCPU戦として記録する", () => {
  const room = ended();
  if (!room.lastRound) throw new Error("missing fixture");
  room.lastRound.players[1]!.appearance = { kind: "cpu", level: 1 };
  const h = renderHook(useProbe, {
    ...input(),
    room,
    loggedIn: true,
    member: { ...membership, accountLinked: true },
  });
  act(() => h.current.open());
  expect(h.current.context).toMatchObject({ opponent: "cpu", accountRequired: true });
});

test("保存領域が読取・書込不可の場合は案内を繰り返さないため表示を省略する", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  for (const method of ["getItem", "setItem"] as const) {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {},
        [method]: () => {
          throw new Error("denied");
        },
      },
    });
    try {
      const h = renderHook(useProbe, input());
      act(() => expect(h.current.open()).toBe(false));
      expect(h.current.context).toBeNull();
      h.unmount();
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
  }
});

const context = { game: "four-shogi" as const, opponent: "cpu" as const, accountRequired: false };
const submitted = (index: number) =>
  JSON.parse(String((requests[index]!.init.body as FormData).get("input")));

test("星評価だけを送信でき、失敗時は入力と送信IDを保ち、二重送信を防ぐ", async () => {
  render(<PostGameFeedbackDialog context={context} theme="four-shogi" onClose={() => {}} />);
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(
    [...dialog().querySelectorAll("button")].find((b) => b.textContent?.includes("送信する"))!
      .disabled,
  ).toBe(true);
  act(() => dialog().querySelector<HTMLInputElement>('[aria-label="4つ星"]')!.click());
  await press(dialog(), "送信する");
  await press(dialog(), "送信する");
  expect(requests).toHaveLength(1);
  const first = submitted(0);
  expect(first).toMatchObject({
    rating: 4,
    body: "",
    kind: "opinion",
    opponent: "cpu",
    game: "four-shogi",
  });
  expect(dialog().querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
  requests[0]!.respond({ message: "保存できません" }, 503);
  await flush();
  expect(dialog().textContent).toContain("保存できません");
  expect(dialog().querySelector<HTMLInputElement>('[aria-label="4つ星"]')!.checked).toBe(true);
  await press(dialog(), "送信する");
  expect(submitted(1)).toEqual(first);
  requests[1]!.respond({ id: crypto.randomUUID() }, 201);
  await flush();
  expect(dialog().textContent).toContain("ご協力ありがとうございます");
});

test("任意コメントを保持し、長すぎる入力を拒否し、修正後は新しい送信IDで送る", async () => {
  render(<PostGameFeedbackDialog context={context} theme="four-shogi" onClose={() => {}} />);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  act(() => dialog.querySelector<HTMLInputElement>('[aria-label="5つ星"]')!.click());
  const comment = dialog.querySelector("textarea")!;
  enter(comment, "a".repeat(2001));
  await press(dialog, "送信する");
  expect(requests).toHaveLength(0);
  expect(dialog.textContent).toContain("2,000文字以内");
  enter(comment, "楽しかったです");
  await press(dialog, "送信する");
  const first = submitted(0);
  requests[0]!.reject(new Error("offline"));
  await flush();
  expect(comment.value).toBe("楽しかったです");
  enter(comment, "また遊びたいです");
  await press(dialog, "送信する");
  expect(submitted(1).body).toBe("また遊びたいです");
  expect(submitted(1).submissionId).not.toBe(first.submissionId);
});
