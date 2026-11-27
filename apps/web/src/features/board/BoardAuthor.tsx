import type { BoardAuthor as Author } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { Link } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { playerPagePath } from "../players/playerProfileQuery";

const authorClasses = "flex min-w-0 max-w-full items-center gap-2";

export function BoardAuthor({
  author,
  game,
  compact = false,
}: {
  author: Author;
  game: GameId;
  compact?: boolean;
}) {
  const content = (
    <>
      <AppAvatar src={author.avatarUrl} />
      <span
        className={
          compact ? "min-w-0 truncate text-sm font-bold" : "min-w-0 font-semibold wrap-anywhere"
        }
      >
        {author.name}
      </span>
    </>
  );
  const target = author.profileTarget;
  if (target?.source !== "profile") return <span className={authorClasses}>{content}</span>;

  return (
    <Link
      to={playerPagePath(
        { profileId: target.profileId, username: author.username },
        game,
        "singles",
      )}
      className={`${authorClasses} relative z-10 rounded-control text-ink no-underline hover:underline underline-offset-2 focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2`}
    >
      {content}
    </Link>
  );
}
