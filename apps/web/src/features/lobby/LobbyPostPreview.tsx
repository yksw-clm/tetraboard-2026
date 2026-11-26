import { useEffect, useState } from "react";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppSkeletonCard } from "../../shared/ui/AppSkeleton";
import { useBoardPreviewView } from "./boardPreviewView";

type PreviewModule = typeof import("./loadLobbyPostPreview");
type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      data: Awaited<ReturnType<PreviewModule["readLobbyPostPreview"]>>;
      Posts: PreviewModule["LobbyPostPreviewContent"];
    };

function useLobbyPostPreview(game: GameId) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    function show(next: PreviewState) {
      if (!signal.aborted) setState(next);
    }
    async function load() {
      const {
        LobbyPostPreviewContent: Posts,
        readLobbyPostPreview,
        boardLoadError,
      } = await import("./loadLobbyPostPreview");
      if (signal.aborted) return;
      try {
        const data = await readLobbyPostPreview(game, signal);
        show({ status: "ready", data, Posts });
      } catch {
        show({ status: "error", message: boardLoadError });
      }
    }
    void load().catch(() => show({ status: "error", message: "投稿を取得できませんでした。" }));
    return () => controller.abort();
  }, [game, attempt]);

  function retry() {
    setState({ status: "loading" });
    setAttempt((previous) => previous + 1);
  }
  return { state, retry };
}

function PostPreviewSkeleton() {
  return (
    <div className="grid gap-2">
      <p role="status" className="sr-only">
        投稿を読み込んでいます…
      </p>
      <AppSkeletonCard className="h-36" />
      <AppSkeletonCard className="h-36" />
      <AppSkeletonCard className="h-36" />
    </div>
  );
}

export function LobbyPostPreview({ game }: { game: GameId }) {
  const { state, retry } = useLobbyPostPreview(game);
  const sectionRef = useBoardPreviewView(game);
  const { name, lobbyPath } = gameCatalog[game];
  const timelinePath = `${lobbyPath}/posts`;
  const headingId = "lobby-post-preview-title";

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      className="min-w-0 [@media(min-width:768px)]:col-span-2 [@media(min-width:768px)]:col-start-1 [@media(min-width:768px)]:row-start-3"
    >
      <AppSectionHeading
        id={headingId}
        title="みんなの投稿"
        description={`${name}の掲示板の新しい投稿です。`}
      >
        <div className="flex shrink-0 items-center gap-1">
          {(state.status !== "ready" || state.data.acceptingPosts) && (
            <AppButtonLink size="compact" appearance="quiet" className="px-2" to={timelinePath}>
              投稿する
            </AppButtonLink>
          )}
          <AppButtonLink size="compact" appearance="quiet" className="px-2" to={timelinePath}>
            もっと見る
          </AppButtonLink>
        </div>
      </AppSectionHeading>
      {state.status === "loading" && <PostPreviewSkeleton />}
      {state.status === "error" && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
          <AppButton appearance="secondary" size="compact" onPress={retry}>
            再試行
          </AppButton>
        </div>
      )}
      {state.status === "ready" && <state.Posts {...state.data} />}
    </section>
  );
}
