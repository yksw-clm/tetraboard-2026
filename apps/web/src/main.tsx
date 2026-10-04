import { updatePageMetadata } from "./publicPages/pageMetadata";
import { startWebAnalytics } from "./analytics/pageAnalytics";
import "./shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router.tsx";

updatePageMetadata(router.state.location.pathname);
router.subscribe((state) => updatePageMetadata(state.location.pathname));
startWebAnalytics(router);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
