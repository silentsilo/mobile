import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "./styles/tokens.css";
import "./styles/base.css";
import App from "./App";

async function start() {
  // Development only, and only when asked for: a release build never runs it.
  if (import.meta.env.DEV && (location.search.includes("mock") || import.meta.env.VITE_MOCK === "1")) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
