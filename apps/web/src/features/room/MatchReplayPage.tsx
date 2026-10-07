import { gameCatalog, defaultGameId } from "@tetraboard/protocol/games";
import { replayViews } from "./replayViews";
import { AppPageLoading, AppPageState } from "../../shared/ui/AppPageState";
import { gameThemes } from "../../shared/ui/appTheme";
import { Suspense } from "react";
import { assertNever } from "@tetraboard/protocol";
import {
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import type { MatchReplayData } from "./matchReplayLoader";
function Replay({ data }: { data: MatchReplayData }) {
  switch (data.game) {
    case "four-reversi": {
      const View = replayViews["four-reversi"];
      return <View key={data.match.id} match={data.match} />;
    }
    case "four-shogi": {
      const View = replayViews["four-shogi"];
      return <View key={data.match.id} match={data.match} frames={data.frames} />;
    }
    default:
      return assertNever(data);
  }
}
export function MatchReplayPage() {
  const data = useLoaderData<MatchReplayData>();
  return (
    <Suspense
      fallback={<AppPageLoading message="棋譜を読み込んでいます…" theme={gameThemes[data.game]} />}
    >
      <Replay data={data} />
    </Suspense>
  );
}

export function MatchReplayErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const publicView = location.pathname.startsWith("/matches/");
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const retryable = status !== 400 && status !== 404;
  return (
    <AppPageState>
      <p role="alert">
        {status === 400
          ? "棋譜のURLが正しくありません。"
          : status === 404
            ? "この棋譜は閲覧できません。"
            : "棋譜を取得できませんでした。もう一度お試しください。"}
      </p>
      {retryable && (
        <AppButton
          size="compact"
          isDisabled={navigation.state === "loading"}
          isPending={navigation.state === "loading"}
          onPress={() => {
            // 同じURLでも遷移を行い、成功時にルーターのエラー境界を解除します。
            void navigate(`${location.pathname}${location.search}${location.hash}`, {
              replace: true,
              state: location.state,
            });
          }}
        >
          再試行
        </AppButton>
      )}
      <AppButtonLink
        size="compact"
        to={publicView ? gameCatalog[defaultGameId].lobbyPath : "/account"}
        state={location.state}
      >
        {publicView ? "ロビーへ戻る" : "マイページへ戻る"}
      </AppButtonLink>
      <FeedbackEntry context={{ page: "error", game: "all" }} />
    </AppPageState>
  );
}
