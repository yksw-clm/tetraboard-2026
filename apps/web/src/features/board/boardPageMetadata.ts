import type { BoardPost, BoardReply } from "@tetraboard/protocol/board";
import {
  boardPostMetadata,
  boardPostPath,
  renderDiscussionForumPostingJsonLd,
} from "@tetraboard/protocol/board-pages";
import { publicOrigin, searchIndexable } from "../../seo/lobbyMetadata";
import { isInitialServerPage } from "../../seo/pageMetadata";

export function boardPageMetadata({
  post,
  replies,
  indexable,
}: {
  post: BoardPost;
  replies: BoardReply[];
  indexable?: boolean;
}) {
  const path = boardPostPath(post.publicNumber);
  const metadata = boardPostMetadata(publicOrigin, post);
  return {
    ...metadata,
    path,
    indexable: searchIndexable && (indexable ?? false),
    game: post.gameId,
    jsonLd:
      isInitialServerPage(path) && post.status === "published"
        ? renderDiscussionForumPostingJsonLd(metadata.canonical, post, replies)
        : null,
  };
}
