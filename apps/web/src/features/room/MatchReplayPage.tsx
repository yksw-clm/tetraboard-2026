import { replayViews } from "./replayViews";
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
    <Suspense fallback={<p role="status">棋譜を読み込んでいます…</p>}>
      <Replay data={data} />
    </Suspense>
  );
}

export function MatchReplayErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const status = isRouteErrorResponse(error) ? error.status : 503;
  const retryable = status !== 400 && status !== 404;
  return (
    <main className="app-theme room-background flex flex-col h-dvh items-center justify-center gap-4 p-6 text-sm">
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
      <AppButtonLink size="compact" to="/account" state={location.state}>
        マイページへ戻る
      </AppButtonLink>
      <FeedbackEntry context={{ page: "error", game: "all" }} />
    </main>
  );
}
