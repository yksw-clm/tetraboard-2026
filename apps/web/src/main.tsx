import "./app/installPreloadRecovery";
import "./shared/clientErrors";
import "./shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router.tsx";
import { updatePageMetadata } from "./seo/pageMetadata";
import { startPublicLobby } from "./seo/startPublicLobby";
import type { RoomLoaderData } from "./features/room/roomLoader";
import type { MatchReplayData } from "./features/room/matchReplayLoader";

function syncMetadata(state: typeof router.state) {
  const data = state.errors ? undefined : (state.loaderData.room as RoomLoaderData | undefined);
  const replay = state.errors
    ? undefined
    : (state.loaderData["public-match"] as MatchReplayData | undefined);
  updatePageMetadata(state.location.pathname, data?.room, replay?.match);
}
syncMetadata(router.state);
router.subscribe(syncMetadata);

const root = document.getElementById("root")!;
startPublicLobby(root, router, () => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
