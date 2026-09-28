import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link } from "react-router";
import { RouterProvider } from "react-router/dom";
import { App } from "./App.tsx";
import { RoomErrorPage, RoomPage } from "./RoomPage.tsx";
import { roomLoader } from "./roomLoader.ts";

const router = createBrowserRouter([
  { path: "/", Component: App },
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
