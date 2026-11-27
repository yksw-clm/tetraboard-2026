import { useEffect, useRef, useState } from "react";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { preloadRecovery, preloadRecoveryMessage } from "../../shared/preloadRecovery";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppSkeletonCard } from "../../shared/ui/AppSkeleton";
import { useAccount } from "../account/useAccount";
import { useViewerKey } from "../board/boardViewer";
import { useBoardPreviewView } from "./boardPreviewView";
import { importLobbyPostPreview } from "./importLobbyPostPreview";
import { BoardLaunchAnnouncement } from "./BoardLaunchAnnouncement";

type PreviewModule = Awaited<ReturnType<typeof importLobbyPostPreview>>;
type PreviewResult =
  | Awaited<ReturnType<PreviewModule["readLobbyPostPreview"]>>
  | { status: "chunk-error"; message: string };
type PreviewData = Extract<PreviewResult, { status: "ready" }>["data"];

type PreviewRequest = { key: string; waiting: boolean; result: PreviewResult | null };
const loadingPreview = { status: "loading" } as const;

function useLobbyPostPreview(game: GameId, key: string, waiting: boolean) {
  const [request, setRequest] = useState<PreviewRequest>({ key, waiting, result: null });
  const previewModule = useRef<Promise<PreviewModule> | null>(null);

  // 初回のセッション確定を待ち、同じ閲覧者の再確認では取得済みの投稿を保ちます。
  if (request.key !== key || (request.waiting && !waiting)) {
    setRequest({ key, waiting, result: null });
  }

  useEffect(() => {
    if (request.waiting || request.result) return;
    const controller = new AbortController();
    const { signal } = controller;
    const show = (result: PreviewResult) => {
      if (signal.aborted) return;
      setRequest((current) => (current === request ? { ...request, result } : current));
    };
    async function load() {
      const { readLobbyPostPreview } = await (previewModule.current ??= importLobbyPostPreview());
      if (!signal.aborted) show(await readLobbyPostPreview(game, signal));
    }
    void load().catch(() => show({ status: "chunk-error", message: preloadRecoveryMessage }));
    return () => controller.abort();
  }, [game, request]);

  function retry() {
    setRequest({ key, waiting: false, result: null });
  }

  function change(update: (current: PreviewData) => PreviewData) {
    setRequest((current) =>
      current.key === key && current.result?.status === "ready"
        ? { ...current, result: { ...current.result, data: update(current.result.data) } }
        : current,
    );
  }

  async function refresh(signal: AbortSignal) {
    const { readLobbyPostPreview } = await (previewModule.current ??= importLobbyPostPreview());
    const result = await readLobbyPostPreview(game, signal);
    signal.throwIfAborted();
    if (result.status === "ready") change(() => result.data);
    return result.status === "api-error" ? result.message : null;
  }

  return { state: request.result ?? loadingPreview, retry, change, refresh };
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

export function LobbyPostPreview({
  game,
  launchBlocked,
  announcementOnly = false,
}: {
  game: GameId;
  launchBlocked: boolean;
  announcementOnly?: boolean;
}) {
  // 初回 JS に含まれるため、コンパイラが付加するメモ化コードを抑えます。
  "use no memo";

  const viewer = useViewerKey();
  const { loading, user } = useAccount();
  const previewKey = `${game}:${viewer}`;
  const { state, retry, change, refresh } = useLobbyPostPreview(game, previewKey, loading && !user);
  const sectionRef = useBoardPreviewView(game, !announcementOnly);
  const { name, lobbyPath } = gameCatalog[game];
  const timelinePath = `${lobbyPath}/posts`;
  const headingId = "lobby-post-preview-title";
  const needsReload = state.status === "chunk-error";

  const announcement = (
    <BoardLaunchAnnouncement
      game={game}
      blocked={launchBlocked}
      acceptingPosts={
        state.status === "ready"
          ? state.data.acceptingPosts
          : state.status === "loading"
            ? null
            : false
      }
    />
  );
  return (
    <>
      {!announcementOnly && (
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
            {state.status === "ready" && state.data.acceptingPosts && (
              <AppButtonLink appearance="primary" to={timelinePath}>
                投稿する
              </AppButtonLink>
            )}
          </AppSectionHeading>
          {state.status === "loading" && <PostPreviewSkeleton />}
          {(needsReload || state.status === "api-error") && (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-danger">
                {state.message}
              </p>
              <AppButton
                appearance="secondary"
                size="compact"
                onPress={needsReload ? () => preloadRecovery.reload() : retry}
              >
                {needsReload ? "再読み込み" : "再試行"}
              </AppButton>
            </div>
          )}
          {state.status === "ready" && (
            <state.Posts key={previewKey} data={state.data} change={change} refresh={refresh} />
          )}
          <AppButtonLink appearance="secondary" className="mt-2 w-full" to={timelinePath}>
            掲示板をすべて見る
          </AppButtonLink>
        </section>
      )}
      {announcement}
    </>
  );
}
