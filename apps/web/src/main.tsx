import { startWebAnalytics } from "./analytics/pageAnalytics";
import "./shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router.tsx";
import { updatePageMetadata } from "./seo/pageMetadata";
import { startPublicLobby } from "./seo/startPublicLobby";

updatePageMetadata(router.state.location.pathname);
router.subscribe((state) => updatePageMetadata(state.location.pathname));
startWebAnalytics(router);

const root = document.getElementById("root")!;
startPublicLobby(root, router, () => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
