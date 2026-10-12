import "./app/installPreloadRecovery";
import { startWebAnalytics } from "./analytics/pageAnalytics";
import "./shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router.tsx";
import { updatePageMetadata } from "./seo/pageMetadata";
import { startPublicLobby } from "./seo/startPublicLobby";
import type { RoomLoaderData } from "./features/room/roomLoader";

function syncMetadata(state: typeof router.state) {
  const data = state.errors ? undefined : (state.loaderData.room as RoomLoaderData | undefined);
  updatePageMetadata(state.location.pathname, data?.room);
}
syncMetadata(router.state);
router.subscribe(syncMetadata);
startWebAnalytics(router);

const root = document.getElementById("root")!;
startPublicLobby(root, router, () => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
