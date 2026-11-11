import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AdminApp } from "./AdminApp";
import { ThemeProvider } from "./components/ThemeProvider";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter basename="/admin">
        <AdminApp />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
