import React from "react";
import ReactDOM from "react-dom/client";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import { ErrorBoundary } from "./ErrorBoundary";
import App from "./App";

const container = document.getElementById("root");
if (!container) throw new Error('Root element "#root" not found in index.html');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
