import { createBrowserRouter, Link, Navigate } from "react-router";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";
import { fourReversiLobbyPath } from "./paths";

export const router = createBrowserRouter([
  { path: "/", element: <Navigate to={fourReversiLobbyPath} replace /> },
  {
    path: fourReversiLobbyPath,
    hydrateFallbackElement: <p role="status">ロビーを読み込んでいます…</p>,
    lazy: async () => {
      const { FourReversiLobbyPage } = await import("../features/lobby/FourReversiLobbyPage");
      return { Component: FourReversiLobbyPage };
    },
  },
  { path: "/rooms/:id", Component: RoomPage, loader: roomLoader, ErrorBoundary: RoomErrorPage },
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
]);
