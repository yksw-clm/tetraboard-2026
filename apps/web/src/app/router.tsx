import { matchReplayLoader } from "../features/room/matchReplayLoader";
import { MatchReplayPage, MatchReplayErrorPage } from "../features/room/MatchReplayPage";
import { AccountLayout } from "../features/account/AccountSession";
import { LoginPage, ProfilePage } from "../features/account/AccountPages";
import { createBrowserRouter, Link, Navigate } from "react-router";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";
import { fourReversiLobbyPath, fourShogiLobbyPath } from "./paths";
import { FeedbackPage } from "../features/feedback/FeedbackPage";
import { UpdatesPage } from "../features/updates/UpdatesPage";

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
        hydrateFallbackElement: <p role="status">棋譜を読み込んでいます…</p>,
      },
      { path: "/", element: <Navigate to={fourReversiLobbyPath} replace /> },
      {
        path: fourReversiLobbyPath,
        hydrateFallbackElement: <p role="status">ロビーを読み込んでいます…</p>,
        lazy: async () => {
          const { FourReversiLobbyPage } = await import("../features/lobby/FourReversiLobbyPage");
          return { Component: FourReversiLobbyPage };
        },
      },
      {
        path: fourShogiLobbyPath,
        hydrateFallbackElement: <p role="status">ロビーを読み込んでいます…</p>,
        lazy: async () => {
          const { FourShogiLobbyPage } = await import("../features/lobby/FourShogiLobbyPage");
          return { Component: FourShogiLobbyPage };
        },
      },
      {
        path: "/rooms/:id",
        Component: RoomPage,
        loader: roomLoader,
        ErrorBoundary: RoomErrorPage,
        hydrateFallbackElement: <p role="status">ルームを読み込んでいます…</p>,
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
