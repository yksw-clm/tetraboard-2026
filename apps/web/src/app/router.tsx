import { matchReplayLoader, publicMatchReplayLoader } from "../features/room/matchReplayLoader";
import { PlayerProfileProvider } from "../features/players/PlayerProfileProvider";
import { ActiveTournamentProvider } from "../features/tournaments/ActiveTournamentProvider";
import { AccountLayout } from "../features/account/AccountSession";
import { createBrowserRouter, Link, replace } from "react-router";
import { matchmakingPath } from "../features/matchmaking/paths";
import { roomLoader } from "../features/room/roomLoader";

import { AppPageLoading } from "../shared/ui/AppPageState";
import { AppRouteErrorPage } from "../shared/ui/AppErrorPage";
import { gameThemes } from "../shared/ui/appTheme";
import {
  fourShogiRulesPath,
  gameIds,
  gameCatalog,
  isGameId,
  type GameId,
} from "@tetraboard/protocol/games";
import type { ComponentType } from "react";
export const lobbyRoutes = {
  "four-gomoku": {
    path: gameCatalog["four-gomoku"].lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/FourGomokuLobbyPage")).FourGomokuLobbyPage,
    }),
  },
  shogi: {
    path: gameCatalog.shogi.lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/ShogiLobbyPage")).ShogiLobbyPage,
    }),
  },
  gomoku: {
    path: gameCatalog.gomoku.lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/GomokuLobbyPage")).GomokuLobbyPage,
    }),
  },
  reversi: {
    path: gameCatalog.reversi.lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/ReversiLobbyPage")).ReversiLobbyPage,
    }),
  },
  "four-reversi": {
    path: gameCatalog["four-reversi"].lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/FourReversiLobbyPage")).FourReversiLobbyPage,
    }),
  },
  "four-shogi": {
    path: gameCatalog["four-shogi"].lobbyPath,
    lazy: async () => ({
      Component: (await import("../features/lobby/FourShogiLobbyPage")).FourShogiLobbyPage,
    }),
  },
} satisfies {
  [G in GameId]: {
    path: (typeof gameCatalog)[G]["lobbyPath"];
    lazy: () => Promise<{ Component: ComponentType }>;
  };
};

const lazyMatchReplayPage = () => ({
  Component: async () => (await import("../features/room/MatchReplayPage")).MatchReplayPage,
  ErrorBoundary: async () =>
    (await import("../features/room/MatchReplayPage")).MatchReplayErrorPage,
});

// 一覧と詳細の遅延読み込み先を共用し、既存画面が読む共通チャンクの細分化を抑えます。
const loadTournamentPages = () => import("../features/tournaments/tournamentRoutes");

const loadBoardPages = () => import("../features/board/BoardPages");

const initialBoardGameId = globalThis.location?.pathname.split("/")[2];

export const router = createBrowserRouter([
  {
    path: "/tournaments",
    lazy: async () => ({
      Component: (await loadTournamentPages()).TournamentListPage,
    }),
    ErrorBoundary: AppRouteErrorPage,
    hydrateFallbackElement: <AppPageLoading message="大会一覧を読み込んでいます…" />,
  },
  {
    ErrorBoundary: AppRouteErrorPage,
    Component: () => (
      <PlayerProfileProvider>
        <ActiveTournamentProvider>
          <AccountLayout />
        </ActiveTournamentProvider>
      </PlayerProfileProvider>
    ),
    children: [
      {
        path: fourShogiRulesPath,
        lazy: () => import("../features/lobby/fourShogiRulesRoute"),
        hydrateFallbackElement: (
          <AppPageLoading message="ルールを読み込んでいます…" theme="four-shogi" />
        ),
      },
      {
        path: "/how-to-play",
        lazy: async () => ({
          Component: (await import("../features/help/HowToPlayPage")).HowToPlayPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="遊び方を読み込んでいます…" />,
      },
      {
        path: "/privacy",
        lazy: async () => {
          const { LegalPage } = await import("../features/privacy/LegalPage");
          return { element: <LegalPage kind="privacy" /> };
        },
        hydrateFallbackElement: (
          <AppPageLoading message="プライバシーポリシーを読み込んでいます…" />
        ),
      },
      {
        path: "/terms",
        lazy: async () => {
          const { LegalPage } = await import("../features/privacy/LegalPage");
          return { element: <LegalPage kind="terms" /> };
        },
        hydrateFallbackElement: <AppPageLoading message="利用規約を読み込んでいます…" />,
      },
      {
        path: "/feedback",
        lazy: async () => ({
          Component: (await import("../features/feedback/FeedbackPage")).FeedbackPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="フィードバックを読み込んでいます…" />,
      },
      {
        path: "/games/:gameId/posts",
        lazy: async () => ({
          Component: (await loadBoardPages()).BoardTimelinePage,
        }),
        hydrateFallbackElement: (
          <AppPageLoading
            message="掲示板を読み込んでいます…"
            theme={isGameId(initialBoardGameId) ? gameThemes[initialBoardGameId] : undefined}
          />
        ),
      },
      {
        path: "/posts/:id",
        lazy: async () => ({
          Component: (await loadBoardPages()).BoardDetailPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="投稿を読み込んでいます…" />,
      },
      {
        path: "/updates",
        lazy: async () => ({
          Component: (await import("../features/updates/UpdatesPage")).UpdatesPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="お知らせを読み込んでいます…" />,
      },
      {
        path: "/updates/:id",
        lazy: async () => ({
          Component: (await import("../features/updates/UpdatesPage")).UpdateDetailPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="お知らせを読み込んでいます…" />,
      },
      {
        path: "/tournaments/:id",
        lazy: async () => ({
          Component: (await loadTournamentPages()).TournamentPage,
        }),
        hydrateFallbackElement: (
          <AppPageLoading message="大会を読み込んでいます…" theme="four-shogi" />
        ),
      },
      {
        path: "/games/four-reversi/matchmaking",
        loader: () => replace(matchmakingPath("four-reversi")),
        hydrateFallbackElement: <AppPageLoading message="マッチングを読み込んでいます…" />,
      },
      {
        path: "/games/shogi/matchmaking",
        loader: () => replace(matchmakingPath("shogi")),
        hydrateFallbackElement: (
          <AppPageLoading message="将棋ロビーを読み込んでいます…" theme="shogi" />
        ),
      },
      {
        path: "/login",
        lazy: async () => ({
          Component: (await import("../features/account/AccountPages")).LoginPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="ログイン画面を読み込んでいます…" />,
      },
      {
        path: "/account/setup",
        lazy: async () => {
          const { ProfilePage } = await import("../features/account/AccountPages");
          return { element: <ProfilePage setup /> };
        },
        hydrateFallbackElement: <AppPageLoading message="プロフィール設定を読み込んでいます…" />,
      },
      {
        path: "/account",
        lazy: async () => ({
          Component: (await import("../features/account/AccountPages")).ProfilePage,
        }),
        hydrateFallbackElement: <AppPageLoading message="プロフィールを読み込んでいます…" />,
      },
      {
        path: "/account/deletion",
        lazy: async () => ({
          Component: (await import("../features/privacy/DeletionPage")).DeletionPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="退会画面を読み込んでいます…" />,
      },
      {
        path: "/account/matches/:matchId",
        loader: matchReplayLoader,
        lazy: lazyMatchReplayPage(),
        hydrateFallbackElement: <AppPageLoading message="棋譜を読み込んでいます…" />,
      },
      {
        path: "/players/:profileId",
        lazy: async () => ({
          Component: (await import("../features/players/PublicPlayerPage")).PublicPlayerPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="プレイヤー情報を読み込んでいます…" />,
      },
      {
        path: "/matches/:matchId",
        id: "public-match",
        loader: publicMatchReplayLoader,
        lazy: lazyMatchReplayPage(),
        hydrateFallbackElement: <AppPageLoading message="棋譜を読み込んでいます…" />,
      },
      {
        path: "/",
        lazy: async () => ({
          Component: (await import("../features/lobby/GeneralLobbyPage")).GeneralLobbyPage,
        }),
        hydrateFallbackElement: <AppPageLoading message="ロビーを読み込んでいます…" />,
      },
      ...gameIds.map((game) => ({
        ...lobbyRoutes[game],
        hydrateFallbackElement: (
          <AppPageLoading message="ロビーを読み込んでいます…" theme={gameThemes[game]} />
        ),
      })),
      {
        path: "/rooms/:id",
        id: "room",
        loader: roomLoader,
        lazy: {
          Component: async () => (await import("../features/room/RoomPage")).RoomPage,
          ErrorBoundary: async () => (await import("../features/room/RoomPage")).RoomErrorPage,
        },
        hydrateFallbackElement: <AppPageLoading message="ルームを読み込んでいます…" />,
      },
      {
        path: "*",
        element: (
          <>
            <p>ページが見つかりません。</p>
            <p>
              <Link to="/">ロビーへ</Link>
            </p>
          </>
        ),
      },
    ],
  },
]);
