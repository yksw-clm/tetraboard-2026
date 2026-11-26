import type { BoardPublishedPost, BoardReply } from "./board";

function renderJsonLd(data: object): string {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export function renderWebSiteJsonLd(url: string): string {
  return renderJsonLd({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "TetraBoard",
    url,
  });
}

type Breadcrumb = { name: string; url: string };

export function renderBreadcrumbJsonLd(
  homeUrl: string,
  ...pages: [Breadcrumb, ...Breadcrumb[]]
): string {
  return renderJsonLd({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "ホーム", url: homeUrl }, ...pages].map(({ name, url }, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item: url,
    })),
  });
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
