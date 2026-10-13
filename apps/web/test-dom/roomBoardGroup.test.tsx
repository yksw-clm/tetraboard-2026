import { expect, test } from "bun:test";
import { RoomBoardGroup, RoomBoardStatusProvider } from "../src/features/room/RoomBoardGroup";
import { RoomBoardLayout, RoomLayout } from "../src/features/room/RoomLayout";
import { clock, render, rerender } from "./harness";

test("状況カードの高さが変わると予約を更新し、配置解除でobserverと保留更新を破棄する", () => {
  const NativeObserver = globalThis.ResizeObserver;
  let notify = () => {};
  let observed: Element | null = null;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe(element: Element) {
      observed = element;
    }
    unobserve() {}
    disconnect() {
      disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
  try {
    function Group({ show }: { show: boolean }) {
      return (
        <RoomBoardStatusProvider status={show ? <div>状況</div> : null}>
          <RoomBoardGroup data-testid="group">
            <div>盤面</div>
          </RoomBoardGroup>
        </RoomBoardStatusProvider>
      );
    }
    const container = render(<Group show />);
    const group = container.querySelector<HTMLElement>('[data-testid="group"]')!;
    expect(observed === group.lastElementChild).toBe(true);
    expect(group.style.getPropertyValue("--board-status-space")).toBe("96px");
    // 実寸法を検証せず、計測境界の値を変えて高さ予約の接続を確認します。
    Object.defineProperty(observed, "getBoundingClientRect", {
      value: () => ({ height: 112.5 }),
    });
    notify();
    clock.advance(16);
    expect(group.style.getPropertyValue("--board-status-space")).toBe("121px");
    notify();
    rerender(container, <Group show={false} />);
    clock.advance(16);
    expect(disconnected).toBe(true);
    expect(group.style.getPropertyValue("--board-status-space")).toBe("");
    expect(group.textContent).toBe("盤面");
  } finally {
    globalThis.ResizeObserver = NativeObserver;
  }
});

test("ライブのPCだけ状況カードを盤面にまとめ、タブレットと棋譜では従来の配置を使う", () => {
  function Layout({ desktop, live }: { desktop: boolean; live: boolean }) {
    return (
      <RoomLayout
        desktop={desktop}
        tab="board"
        onTabChange={() => {}}
        board={
          <RoomBoardLayout>
            <div>盤面</div>
          </RoomBoardLayout>
        }
        info={<div>ルーム情報</div>}
        status={<div data-testid="status">状況</div>}
        chat={<div>チャット</div>}
        replay={null}
        statusBelowBoard={live}
      />
    );
  }
  const container = render(<Layout desktop live />);
  const boardSection = container.querySelector('[aria-label="盤面とプレイヤー"]')!;
  expect(boardSection.querySelector('[data-testid="status"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-testid="status"]')).toHaveLength(1);
  rerender(container, <Layout desktop live={false} />);
  expect(
    container.querySelector('[aria-label="盤面とプレイヤー"] [data-testid="status"]'),
  ).toBeNull();
  expect(container.querySelectorAll('[data-testid="status"]')).toHaveLength(1);
  rerender(container, <Layout desktop={false} live />);
  expect(container.querySelector('[data-with-status="true"]')).toBeNull();
  expect(container.querySelectorAll('[data-testid="status"]')).toHaveLength(1);
});
