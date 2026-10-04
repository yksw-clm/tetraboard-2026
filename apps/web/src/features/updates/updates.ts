import { gameCatalog, type GameScope } from "@tetraboard/protocol/games";
export type ServiceUpdate = {
  id: string;
  date: string;
  kind: "feature" | "improvement" | "fix";
  game: GameScope;
  title: string;
  body: string;
};
// 機能と同じ公開成果物に含めます。投稿原文・個人情報・非公開画像は転載しません。
export const serviceUpdates: ServiceUpdate[] = [
  {
    id: "feedback",
    date: "2026-10-04",
    kind: "feature",
    game: "all",
    title: "不具合やご意見を送れるようになりました",
    body: "登録なしで、不具合や機能のアイデアを送れます。画像も1枚添付できます。いただいた声を、これからの改善に役立てます。",
  },
];
export const updateKindLabels = {
  feature: "新機能",
  improvement: "改善",
  fix: "不具合修正",
} as const;
export function updateGameLabel(game: GameScope): string {
  return game === "all" ? "サービス全体" : gameCatalog[game].name;
}
export function sortedUpdates() {
  return [...serviceUpdates].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
}
