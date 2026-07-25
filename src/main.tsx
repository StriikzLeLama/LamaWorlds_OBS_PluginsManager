import React from "react";
import ReactDOM from "react-dom/client";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import { ErrorBoundary } from "./ErrorBoundary";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
