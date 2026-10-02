import { createBrowserRouter, Link, Navigate } from "react-router";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";
import { fourReversiLobbyPath } from "./paths";

import { AccountLayout } from "../features/account/AccountSession";

export const router = createBrowserRouter([
  {
    Component: AccountLayout,
    children: [
      {
        path: "/login",
        lazy: async () => ({
          Component: (await import("../features/account/AccountPage")).LoginPage,
        }),
      },
      {
        path: "/account",
        lazy: async () => ({
          Component: (await import("../features/account/AccountPage")).AccountPage,
        }),
      },
      {
        path: "/account/setup",
        lazy: async () => {
          const { AccountPage } = await import("../features/account/AccountPage");
          return { Component: () => <AccountPage setup /> };
        },
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
