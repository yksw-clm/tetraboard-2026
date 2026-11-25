import "./app/installPreloadRecovery";
import "./shared/clientErrors";
import "./shared/visits";
import "./shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router.tsx";
import { startPageMetadata } from "./seo/pageMetadata";
import { startPublicLobby } from "./seo/startPublicLobby";

const root = document.getElementById("root")!;
startPageMetadata(router, root);
startPublicLobby(root, router, () => {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
