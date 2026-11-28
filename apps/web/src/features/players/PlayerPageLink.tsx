import type { RoomMode } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { Link, createPath, useLocation, useResolvedPath, type LinkProps } from "react-router";
import { playerPagePath } from "./playerProfileQuery";

export function PlayerPageLink({
  profile,
  game,
  mode,
  target,
  ...props
}: Pick<LinkProps, "children" | "className" | "target" | "rel" | "aria-describedby"> & {
  profile: { profileId: string; username?: string | null };
  game: GameId;
  mode: RoomMode;
}) {
  const to = playerPagePath(profile, game, mode);
  const location = useLocation();
  const path = useResolvedPath(to);
  // 同じURLへのリンクは履歴を置き換えるため、その項目の遷移元を維持します。
  const replace = createPath(location) === createPath(path);
  const state =
    target === "_blank" ? undefined : replace ? location.state : { profileBackSteps: 1 };
  return <Link {...props} to={to} target={target} replace={replace} state={state} />;
}
