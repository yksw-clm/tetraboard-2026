import { expect, test } from "bun:test";
import { gameIds } from "@tetraboard/protocol/games";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { act, flush, press, render, renderHook, requests, rerender, wrap } from "./harness";
import { profile } from "../test/fixtures/account";

function open(view: HTMLElement, title: string) {
  const button = [...view.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === title,
  );
  if (!button) throw new Error(`Missing entry: ${title}`);
  act(() => button.click());
}

for (const game of gameIds) {
  test(`${game}: CPUレベルはquick作成だけに表示・送信し、閉じる・失敗後も保持する`, async () => {
    function Probe() {
      const h = useRoomEntry(game);
      return (
        <LobbyView
          game={game}
          name={h.name}
          roomCode={h.roomCode}
          mode={h.mode}
          cpuLevel={h.cpuLevel}
          onCpuLevelChange={h.setCpuLevel}
          timeControl={h.timeControl}
          isSubmitting={h.isSubmitting}
          message={h.message}
          renderRooms={() => null}
          onNameChange={h.setName}
          onRoomCodeChange={h.setRoomCode}
          onModeChange={h.setMode}
          onTimeControlChange={h.setTimeControl}
          onClearMessage={h.clearMessage}
          onSubmitRoom={(intent) => void h.submitRoom(intent)}
        />
      );
    }
    const view = render(wrap(profile)(<Probe />));
    await flush();
    open(view, "CPUと遊ぶ");
    await flush();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const radio = (level: number) =>
      dialog().querySelector<HTMLInputElement>(`input[name="cpu-level"][value="${level}"]`)!;
    expect(radio(1).checked).toBe(true);
    act(() => radio(2).click());
    await flush();
    expect(radio(2).checked).toBe(true);
    act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
    open(view, "CPUと遊ぶ");
    await flush();
    expect(radio(2).checked).toBe(true);
    press(dialog(), "CPUとの待機室へ");
    requests.at(-1)!.respond({ user: profile });
    await flush();
    const creation = requests.at(-1)!;
    expect(JSON.parse(String(creation.init.body))).toMatchObject({ quickPlay: true, cpuLevel: 2 });
    expect(radio(2).disabled).toBe(true);
    creation.respond({ error: "internal_error" }, 500);
    await flush();
    expect(radio(2).checked).toBe(true);
    expect(radio(2).disabled).toBe(false);
    act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
    open(view, "公開ルームを作る");
    await flush();
    expect(dialog().textContent).not.toContain("CPUレベル");
    press(dialog(), "ルームを作る");
    requests.at(-1)!.respond({ user: profile });
    await flush();
    expect(JSON.parse(String(requests.at(-1)!.init.body)).cpuLevel).toBeUndefined();
    requests.at(-1)!.respond({ error: "internal_error" }, 500);
    await flush();
    rerender(view, null);
    const fresh = renderHook(() => useRoomEntry(game), undefined, wrap());
    expect(fresh.current.cpuLevel).toBe(1);
    fresh.unmount();
  });
  test(`${game}: OAuthから戻るとCPUレベルも復元し、旧下書きはLv1にする`, () => {
    for (const cpuLevel of [undefined, 2] as const) {
      const h = renderHook(
        () => useRoomEntry(game),
        undefined,
        wrap(null, {
          pathname: `/games/${game}`,
          state: {
            registrationReturn: {
              path: `/games/${game}`,
              createdAt: Date.now(),
              oauthStarted: true,
              entry: { intent: "quick", name: "下書き", roomCode: "", mode: "singles", cpuLevel },
            },
          },
        }),
      );
      expect(h.current.cpuLevel).toBe(cpuLevel ?? 1);
      h.unmount();
    }
  });
}
