import "../../shared/heroui.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { TournamentMock } from "./TournamentMock";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <TournamentMock />
    </HashRouter>
  </StrictMode>,
);
