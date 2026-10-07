import { liveViews } from "./liveViews";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { roomChangedMessage } from "../../shared/roomAccess";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import { fourReversiLobbyPath } from "../../app/paths";
import type { RoomLoaderData } from "./roomLoader";
import { AppPageLoading, AppPageState } from "../../shared/ui/AppPageState";
import { gameThemes } from "../../shared/ui/appTheme";
import { Suspense } from "react";
import { assertNever } from "@tetraboard/protocol";
function LiveRoom({ data }: { data: RoomLoaderData }) {
  const common = {
    initialMembership: data.membership,
    initialPresence: data.presence,
    initialServerNowMs: data.serverNowMs,
    invited: data.invited,
  };
  const key = `${data.room.instanceId}:${data.membership?.playerId ?? "spectator"}`;
  switch (data.game) {
    case "four-reversi": {
      const View = liveViews["four-reversi"];
      return <View key={key} {...common} initialRoom={data.room} />;
    }
    case "four-shogi": {
      const View = liveViews["four-shogi"];
      return (
        <View
          key={key}
          {...common}
          initialRoom={data.room}
          initialFormationAnalysisSupported={data.formationAnalysisSupported}
        />
      );
    }
    default:
      return assertNever(data);
  }
}
export function RoomPage() {
  const data = useLoaderData<RoomLoaderData>();
  return (
    <Suspense
      fallback={
        <AppPageLoading message="ルームを読み込んでいます…" theme={gameThemes[data.game]} />
      }
    >
      <LiveRoom data={data} />
    </Suspense>
  );
}

export function RoomErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.status === 404
      ? "ルームが見つかりません。"
      : error.status === 400
        ? "ルームURLが不正です。招待リンクや部屋番号を確認してください。"
        : error.status === 410
          ? roomChangedMessage
          : error.status === 503
            ? "本人確認ができませんでした。再読み込みしてください。"
            : "ルーム情報を取得できませんでした。"
    : "ルーム情報を取得できませんでした。";

  return (
    <AppPageState>
      <p role="alert">{message}</p>
      <AppButtonLink size="compact" to={fourReversiLobbyPath}>
        ロビーへ
      </AppButtonLink>
      <FeedbackEntry context={{ page: "error", game: "all" }} />
    </AppPageState>
  );
}
