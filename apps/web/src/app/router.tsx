import { DeletionPage } from "../features/privacy/DeletionPage";
import { LegalPage } from "../features/privacy/LegalPage";
import { matchReplayLoader, publicMatchReplayLoader } from "../features/room/matchReplayLoader";
import { MatchReplayPage, MatchReplayErrorPage } from "../features/room/MatchReplayPage";
import { PlayerProfileProvider } from "../features/players/PlayerProfileProvider";
import { AccountLayout } from "../features/account/AccountSession";
import { LoginPage, ProfilePage } from "../features/account/AccountPages";
import { createBrowserRouter, Link } from "react-router";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";

import { FeedbackPage } from "../features/feedback/FeedbackPage";
import { UpdatesPage, UpdateDetailPage } from "../features/updates/UpdatesPage";

import { AppPageLoading } from "../shared/ui/AppPageState";
import { AppRouteErrorPage } from "../shared/ui/AppErrorPage";
import { gameThemes } from "../shared/ui/appTheme";
import { gameIds, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import type { ComponentType } from "react";
import { LayoutGroup } from "motion/react";
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
export const router = createBrowserRouter([
  {
    ErrorBoundary: AppRouteErrorPage,
    Component: () => (
      // ロビーページが入れ替わっても、選択背景の移動を同じグループで引き継ぎます。
      <LayoutGroup id="lobby-navigation">
        <PlayerProfileProvider>
          <AccountLayout />
        </PlayerProfileProvider>
      </LayoutGroup>
    ),
    children: [
      { path: "/privacy", element: <LegalPage kind="privacy" /> },
      { path: "/terms", element: <LegalPage kind="terms" /> },
      { path: "/feedback", Component: FeedbackPage },
      { path: "/updates", Component: UpdatesPage },
      { path: "/updates/:id", Component: UpdateDetailPage },
      {
        path: "/tournaments/:id",
        lazy: async () => ({
          Component: (await import("../features/tournaments/TournamentPage")).TournamentPage,
        }),
        hydrateFallbackElement: (
          <AppPageLoading message="大会を読み込んでいます…" theme="four-shogi" />
        ),
      },
      { path: "/login", Component: LoginPage },
      { path: "/account/setup", element: <ProfilePage setup /> },
      { path: "/account", Component: ProfilePage },
      { path: "/account/deletion", Component: DeletionPage },
      {
        path: "/account/matches/:matchId",
        Component: MatchReplayPage,
        loader: matchReplayLoader,
        ErrorBoundary: MatchReplayErrorPage,
        hydrateFallbackElement: <AppPageLoading message="棋譜を読み込んでいます…" />,
      },
      {
        path: "/matches/:matchId",
        Component: MatchReplayPage,
        loader: publicMatchReplayLoader,
        ErrorBoundary: MatchReplayErrorPage,
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
        Component: RoomPage,
        loader: roomLoader,
        ErrorBoundary: RoomErrorPage,
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
