import type { BoardPost, BoardPublishedPost, BoardReply } from "./board";
import { boardPostExcerpt, boardPostPath } from "./boardPresentation";
import { gameCatalog } from "./games";
import { renderJsonLd } from "./structuredData";

export { boardPostPath };

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
  return {
    title: `${boardPostExcerpt(post.text, 30)}${titleSuffix}`,
    description: boardPostExcerpt(post.text, 120),
    canonical,
  };
}

function boardEntryData({ author, postedAtMs, text }: BoardReply) {
  return {
    author: { "@type": "Person", name: author.name },
    datePublished: new Date(postedAtMs).toISOString(),
    text,
  };
}

export function renderDiscussionForumPostingJsonLd(
  canonical: string,
  post: BoardPublishedPost,
  replies: BoardReply[],
): string {
  return renderJsonLd({
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    url: canonical,
    ...boardEntryData(post),
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/LikeAction",
      userInteractionCount: post.likeCount,
    },
    ...(replies.length > 0 && {
      comment: replies.map((reply) => ({ "@type": "Comment", ...boardEntryData(reply) })),
    }),
  });
}
