import "./index.css";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Missing "#root" element');
}

createRoot(rootEl).render(
  <ErrorBoundary>
    <>
      <App />
      <Toaster
        position="top-center"
        richColors
        toastOptions={{
          className: "text-sm",
        }}
      />
    </>
  </ErrorBoundary>
);