import { expect, test } from "bun:test";
import { RegistrationPrompt } from "../src/features/account/RegistrationPrompt";
import { render, rerender } from "./harness";

test("両ゲームの登録案内はバッジの例・対象条件・ゲスト記録の非引継ぎを伝える", () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const view = render(
      <RegistrationPrompt
        game={game}
        humanOnly={false}
        result
        seated
        busy={false}
        onRegister={() => {}}
      />,
    );
    expect(view.textContent).toContain("これからの対局で、バッジを集めよう");
    expect(view.textContent).toContain("対人シングルス");
    expect(view.textContent).toContain("CPU戦も保存されます。");
    expect(view.textContent).toContain("CPUを含む対局は、戦績・ランキング・バッジの対象外です。");
    expect(view.textContent).toContain("今回のゲスト対局は");
    expect(view.textContent).toContain("参加し直してください");
    const images = view.querySelectorAll<HTMLImageElement>("img");
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute("src")).toBe(`/assets/badges/${game}/games-star-1.webp`);
    expect(images[1]!.getAttribute("src")).toBe(`/assets/badges/${game}/wins-star-1.webp`);
    expect(view.textContent).toContain("獲得できるバッジの例");
    rerender(view, <RegistrationPrompt game={game} humanOnly busy={false} onRegister={() => {}} />);
    expect(view.textContent).toContain("登録して、対局の成果を残そう");
    expect(view.textContent).not.toContain("今回のゲスト対局は");
    rerender(view, null);
  }
});
