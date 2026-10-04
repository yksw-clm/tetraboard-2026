import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { extractPublicRules, readPublicRules, renderPublicRules } from "../build/readPublicRules";
import { gameIds } from "@tetraboard/protocol/games";
import { publicPages } from "../src/publicPages/catalog";

test("公開ルールは正本と共通の時計仕様から生成し、内部状態や決定履歴を含めない", async () => {
  for (const game of gameIds) {
    const content = await readPublicRules(game);
    expect(content.html).toContain("持ち時間");
    expect(content.html).toContain("30秒");
    expect(content.html).not.toContain("保持するルール状態");
    expect(content.html).not.toContain("決定経緯");
    expect(content.html).not.toContain("chooseCpuAction");
    expect(content.headings.length).toBeGreaterThan(5);
    for (const heading of content.headings) expect(content.html).toContain(`id="${heading.id}"`);
    const source = await readFile(
      new URL(`../../../docs/rules/${game}.md`, import.meta.url),
      "utf8",
    );
    const first = extractPublicRules(source)
      .split("\n")
      .find((line) => line.startsWith("### "))!
      .slice(4);
    expect(content.headings[0]!.title).toBe(first);
    expect(publicPages[game].rules.path).toBe(`${publicPages[game].lobby.path}/rules`);
  }
});
test("欠落・重複した公開範囲と、文書相対リンク・壊れたアンカーを拒否する", () => {
  for (const source of [
    "",
    "<!-- public-rules:start -->x",
    "<!-- public-rules:end --><!-- public-rules:start -->",
    "<!-- public-rules:start --><!-- public-rules:end -->",
    "<!-- public-rules:start -->x<!-- public-rules:start --><!-- public-rules:end -->",
  ])
    expect(() => extractPublicRules(source)).toThrow();
  for (const target of ["../../README.md", "#missing", "javascript:alert(1)"])
    expect(() => renderPublicRules(`### ルール\n\n[参照](${target})`)).toThrow();
  const changed = renderPublicRules("### 更新されたルール\n\n正本の変更を表示する。");
  expect(changed.html).toContain("正本の変更を表示する。");
});
