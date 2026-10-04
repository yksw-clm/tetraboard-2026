import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GameId } from "@tetraboard/protocol/games";
import type { RulesContent } from "../src/publicPages/PublicContent";

// Bun 1.4.2で実行するビルド専用API。Web/Workerへパーサーを出力しない。
declare const Bun: {
  markdown: {
    html: (source: string, options: { noHtmlBlocks: boolean; noHtmlSpans: boolean }) => string;
  };
};
const root = new URL("../../../", import.meta.url);
const sources = {
  "four-reversi": "docs/rules/four-reversi.md",
  "four-shogi": "docs/rules/four-shogi.md",
} satisfies Record<GameId, string>;

export function extractPublicRules(source: string): string {
  const start = "<!-- public-rules:start -->";
  const end = "<!-- public-rules:end -->";
  if (
    source.split(start).length !== 2 ||
    source.split(end).length !== 2 ||
    source.indexOf(start) >= source.indexOf(end)
  )
    throw new Error("公開ルール範囲が欠落・重複しています");
  const selected = source.slice(source.indexOf(start) + start.length, source.indexOf(end)).trim();
  if (!selected) throw new Error("公開ルール範囲が空です");
  return selected;
}
export function renderPublicRules(markdown: string): RulesContent {
  const headings: RulesContent["headings"] = [];
  const normalized = markdown.replace(/^### (.+)$/gm, (_, title: string) => {
    const id = `rule-${headings.length + 1}`;
    headings.push({ id, title });
    return `## ${title}`;
  });
  let html = Bun.markdown.html(normalized, { noHtmlBlocks: true, noHtmlSpans: true });
  let headingIndex = 0;
  html = html.replace(/<h2>/g, () => `<h2 id="${headings[headingIndex++]?.id}">`);
  if (!headings.length || headingIndex !== headings.length)
    throw new Error("公開ルールの見出しが不正です");
  const ids = new Set(headings.map((heading) => heading.id));
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1]!;
    if (target.startsWith("#") && ids.has(target.slice(1))) continue;
    if (/^https:\/\//.test(target)) continue;
    throw new Error(`公開ルールの未解決リンク: ${target}`);
  }
  return { html, headings };
}
export async function readPublicRules(game: GameId): Promise<RulesContent> {
  const [rules, common] = await Promise.all([
    readFile(new URL(sources[game], root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
  ]);
  return renderPublicRules(`${extractPublicRules(rules)}\n\n${extractPublicRules(common)}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const game = process.argv[2];
  if (game !== "four-reversi" && game !== "four-shogi") throw new Error("未知の公開ゲーム");
  console.log(JSON.stringify(await readPublicRules(game)));
}
