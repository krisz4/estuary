import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@/index.css";

const container = document.getElementById("root");
if (container === null) {
  // index.html owns this element. If it is missing, nothing below will render
  // and a silent blank page is much harder to diagnose than a thrown message.
  throw new Error("No #root element found — check apps/web/index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
