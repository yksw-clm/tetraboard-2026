import { expect, test } from "bun:test";
import { RegistrationPrompt } from "../src/features/account/RegistrationPrompt";
import { render, rerender } from "./harness";

test("結果の登録案内は今回の記録・同じ席での再戦・CPU戦の対象条件を伝える", () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const view = render(
      <RegistrationPrompt game={game} humanOnly={false} busy={false} onRegister={() => {}} />,
    );
    expect(view.textContent).toContain("この対局を、自分の記録に残そう");
    expect(view.textContent).toContain("対人シングルス");
    expect(view.textContent).toContain("CPU戦も保存されます。");
    expect(view.textContent).toContain("CPUを含む対局は、戦績・ランキング・バッジの対象外です。");
    expect(view.textContent).toContain("この対局の棋譜がマイページに追加されます");
    expect(view.textContent).toContain("同じ席で");
    expect(view.textContent).not.toContain("参加し直してください");
    const images = view.querySelectorAll<HTMLImageElement>("figure img");
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute("src")).toBe(`/assets/badges/${game}/games-star-1.webp`);
    expect(images[1]!.getAttribute("src")).toBe(`/assets/badges/${game}/wins-star-1.webp`);
    expect(view.textContent).toContain("獲得できるバッジの例");
    rerender(view, <RegistrationPrompt game={game} humanOnly busy={false} onRegister={() => {}} />);
    expect(view.textContent).toContain("この対局の戦績と棋譜がマイページに追加されます");
    expect(view.textContent).not.toContain("今回のゲスト対局は");
    rerender(view, null);
  }
});

test("Googleの共通認証ボタンは公式画像・統一文言・処理中ロックを持つ", () => {
  const view = render(
    <RegistrationPrompt humanOnly busy pendingProvider="google" onRegister={() => {}} />,
  );
  const button = view.querySelector("button")!;
  expect(button.textContent).toContain("Googleで続ける");
  expect(button.disabled).toBe(true);
  expect(button.querySelector('[data-slot="pending-spinner"]')).not.toBeNull();
  expect(button.querySelector("img")!.getAttribute("src")).toBe("/assets/auth/google.png");
  expect(button.querySelector("img")!.getAttribute("alt")).toBe("");
});

test("Discord送信中は両認証ボタンをロックし、選んだボタンだけが処理中になる", () => {
  const view = render(
    <RegistrationPrompt humanOnly busy pendingProvider="discord" onRegister={() => {}} />,
  );
  const buttons = view.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.textContent).toContain("Googleで続ける");
  expect(buttons[1]!.textContent).toContain("Discordで続ける");
  expect([...buttons].every((button) => button.disabled)).toBe(true);
  expect(buttons[0]!.querySelector('[data-slot="pending-spinner"]')).toBeNull();
  expect(buttons[1]!.querySelector('[data-slot="pending-spinner"]')).not.toBeNull();
});
