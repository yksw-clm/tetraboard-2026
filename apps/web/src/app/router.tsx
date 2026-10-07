import { matchReplayLoader, publicMatchReplayLoader } from "../features/room/matchReplayLoader";
import { MatchReplayPage, MatchReplayErrorPage } from "../features/room/MatchReplayPage";
import { AccountLayout } from "../features/account/AccountSession";
import { LoginPage, ProfilePage } from "../features/account/AccountPages";
import { createBrowserRouter, Link, Navigate } from "react-router";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";
import { fourReversiLobbyPath } from "./paths";
import { FeedbackPage } from "../features/feedback/FeedbackPage";
import { UpdatesPage } from "../features/updates/UpdatesPage";

import { AppPageLoading } from "../shared/ui/AppPageState";
import { gameThemes } from "../shared/ui/appTheme";
import { gameIds, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import type { ComponentType } from "react";
export const lobbyRoutes = {
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
    Component: AccountLayout,
    children: [
      { path: "/feedback", Component: FeedbackPage },
      { path: "/updates", Component: UpdatesPage },
      { path: "/login", Component: LoginPage },
      { path: "/account/setup", element: <ProfilePage setup /> },
      { path: "/account", Component: ProfilePage },
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
      { path: "/", element: <Navigate to={fourReversiLobbyPath} replace /> },
      ...gameIds.map((game) => ({
        ...lobbyRoutes[game],
        hydrateFallbackElement: (
          <AppPageLoading message="ロビーを読み込んでいます…" theme={gameThemes[game]} />
        ),
      })),
      {
        path: "/rooms/:id",
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
              <Link to={fourReversiLobbyPath}>ロビーへ</Link>
            </p>
          </>
        ),
      },
    ],
  },
]);
