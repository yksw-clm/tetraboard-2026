import { isGameId } from "@tetraboard/protocol/games";
import { useParams } from "react-router";
import { AppPageLoading } from "../../shared/ui/AppPageState";
import { gameThemes } from "../../shared/ui/appTheme";

export function BoardTimelineLoading() {
  const { gameId } = useParams();
  return (
    <AppPageLoading
      message="掲示板を読み込んでいます…"
      theme={isGameId(gameId) ? gameThemes[gameId] : "default"}
    />
  );
}
