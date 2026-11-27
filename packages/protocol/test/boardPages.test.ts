import { expect, test } from "bun:test";
import type { BoardPublishedPost } from "../src/board";
import { boardPostMetadata, renderDiscussionForumPostingJsonLd } from "../src/boardPages";

const origin = "https://tetraboard.net";
const post: BoardPublishedPost = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "published",
  publicNumber: 413,
  gameId: "shogi",
  author: { name: '投稿者"<', avatarUrl: null, profileTarget: null },
  postedAtMs: Date.UTC(2026, 10, 25, 13, 2, 3),
  text: '投稿の本文\n</script> < "',
  replyCount: 1,
  likeCount: 2,
  liked: false,
  own: false,
};

test("投稿の抜粋は空白をまとめ、書記素で30字と120字を上限にする", () => {
  const titleSuffix = "｜将棋の掲示板 | TetraBoard";
  const thirty = "👩‍👩‍👧‍👦か\u3099".repeat(15);
  const oneHundredTwenty = thirty.repeat(4);
  expect(boardPostMetadata(origin, { ...post, text: thirty })).toEqual({
    title: thirty + titleSuffix,
    description: thirty,
    canonical: `${origin}/posts/413`,
  });
  expect(boardPostMetadata(origin, { ...post, text: thirty + "先" }).title).toBe(
    `${thirty}…${titleSuffix}`,
  );
  expect(boardPostMetadata(origin, { ...post, text: oneHundredTwenty }).description).toBe(
    oneHundredTwenty,
  );
  expect(boardPostMetadata(origin, { ...post, text: oneHundredTwenty + "先" }).description).toBe(
    `${oneHundredTwenty}…`,
  );
  expect(boardPostMetadata(origin, { ...post, text: "\n  初手\n\r\t　次の手   \t" })).toEqual({
    title: `初手 次の手${titleSuffix}`,
    description: "初手 次の手",
    canonical: `${origin}/posts/413`,
  });
});

test("削除された投稿のメタ情報にはゲーム名と返信数が入る", () => {
  const { id, publicNumber, gameId, postedAtMs, replyCount } = post;
  expect(
    boardPostMetadata(origin, {
      id,
      publicNumber,
      gameId,
      postedAtMs,
      replyCount,
      status: "deleted",
    }),
  ).toEqual({
    title: "削除された投稿｜将棋の掲示板 | TetraBoard",
    description: "将棋の掲示板の削除された投稿です。返信 1 件を読めます。",
    canonical: `${origin}/posts/413`,
  });
});

test("掲示板のJSON-LDはHTMLを閉じずに全文を復元でき、返信がなければcommentを省く", () => {
  const { canonical } = boardPostMetadata(origin, post);
  const reply = { ...post, postedAtMs: post.postedAtMs + 1000, text: '返信の本文\n</script> < "' };
  function readJson(replies: (typeof reply)[]) {
    const html = renderDiscussionForumPostingJsonLd(canonical, post, replies);
    const json = html.match(/^<script type="application\/ld\+json">([^<]*)<\/script>$/)?.[1];
    expect(json).toContain("\\u003c/script>");
    return JSON.parse(json!);
  }
  expect(readJson([reply])).toEqual({
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    url: canonical,
    author: { "@type": "Person", name: post.author.name },
    datePublished: "2026-11-25T13:02:03.000Z",
    text: post.text,
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/LikeAction",
      userInteractionCount: 2,
    },
    comment: [
      {
        "@type": "Comment",
        author: { "@type": "Person", name: reply.author.name },
        datePublished: "2026-11-25T13:02:04.000Z",
        text: reply.text,
      },
    ],
  });
  expect(readJson([])).not.toHaveProperty("comment");
});
