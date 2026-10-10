import { expect, test } from "bun:test";
import { useState } from "react";
import { ReplayCard } from "../src/features/room/ReplayCard";
import { act, flush, render, wrap } from "./harness";

function Preview() {
  const [index, select] = useState(1);
  return (
    <ReplayCard
      theme="shogi"
      replay={{
        index,
        select,
        frames: [
          { label: "開始局面" },
          { label: "1: ▲7六歩", accessibleLabel: "1: 先手7六歩" },
          { label: "2: △3四歩", accessibleLabel: "2: 後手3四歩" },
          { label: "1234: ▲5五銀右引不成", accessibleLabel: "1234: 先手5五銀右引不成" },
        ],
      }}
    />
  );
}

test("棋譜の選択値は▲△、読み上げ名は先後を含み、前後移動で追従する", async () => {
  const view = render(wrap()(<Preview />));
  await flush();
  const trigger = () => view.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  expect(trigger().textContent).toContain("1: ▲7六歩");
  expect(trigger().getAttribute("aria-label")).toBe("棋譜の局面 1: 先手7六歩");
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="棋譜を1つ進む"]')!.click());
  await flush();
  expect(trigger().textContent).toContain("2: △3四歩");
  expect(trigger().getAttribute("aria-label")).toBe("棋譜の局面 2: 後手3四歩");
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="棋譜を1つ戻る"]')!.click());
  await flush();
  expect(trigger().textContent).toContain("1: ▲7六歩");
  act(() => trigger().click());
  await flush();
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map((option) => option.textContent?.trim())).toEqual([
    "開始局面",
    "1: ▲7六歩",
    "2: △3四歩",
    "1234: ▲5五銀右引不成",
  ]);
  expect(options[2].getAttribute("aria-label")).toBe("2: 後手3四歩");
  expect(options[3].getAttribute("aria-label")).toBe("1234: 先手5五銀右引不成");
  act(() => (options[3] as HTMLElement).click());
  await flush();
  expect(trigger().textContent).toContain("1234: ▲5五銀右引不成");
  expect(trigger().getAttribute("aria-label")).toBe("棋譜の局面 1234: 先手5五銀右引不成");
});

test("リバーシの読み上げ名と表示ラベルは既存のまま", async () => {
  const view = render(
    wrap()(<ReplayCard replay={{ index: 0, select: () => {}, frames: [{ label: "5: 赤E6" }] }} />),
  );
  await flush();
  const trigger = view.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  expect(trigger.textContent).toContain("5: 赤E6");
  expect(trigger.getAttribute("aria-label")).toBe("棋譜の局面");
});
