import type { BoardPost } from "./board";
import { gameCatalog } from "./games";

export { renderDiscussionForumPostingJsonLd } from "./structuredData";

export const boardPostPath = (id: string) => `/posts/${encodeURIComponent(id)}`;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

function excerpt(characters: string[], limit: number) {
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…`
    : characters.join("");
}

export function boardPostMetadata(origin: string, post: BoardPost) {
  const gameName = gameCatalog[post.gameId].name;
  const canonical = new URL(boardPostPath(post.id), origin).href;
  const titleSuffix = `｜${gameName}の掲示板 | TetraBoard`;
  if (post.status === "deleted") {
    return {
      title: `削除された投稿${titleSuffix}`,
      description: `${gameName}の掲示板の削除された投稿です。返信 ${post.replyCount} 件を読めます。`,
      canonical,
    };
  }
  const normalized = post.text.replace(/\s+/g, " ").trim();
  const characters = Array.from(segmenter.segment(normalized), ({ segment }) => segment);
  return {
    title: `${excerpt(characters, 30)}${titleSuffix}`,
    description: excerpt(characters, 120),
    canonical,
  };
}
