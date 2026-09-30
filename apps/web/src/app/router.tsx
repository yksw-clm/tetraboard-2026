import { createBrowserRouter, Link } from "react-router";
import { HomePage } from "../features/home/HomePage";
import { RoomErrorPage, RoomPage } from "../features/room/RoomPage";
import { roomLoader } from "../features/room/roomLoader";

export const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/rooms/:id", Component: RoomPage, loader: roomLoader, ErrorBoundary: RoomErrorPage },
  {
    path: "*",
    element: (
      <>
        <p>ページが見つかりません。</p>
        <p>
          <Link to="/">トップへ</Link>
        </p>
      </>
    ),
  },
]);
