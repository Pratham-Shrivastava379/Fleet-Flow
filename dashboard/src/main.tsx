import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Sentry from "@sentry/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import "./styles.css";

// Phase 13 (blueprint §11.4, web-dashboard surface). Error tracking is
// stub-until-configured like the backend/Android surfaces: without
// VITE_SENTRY_DSN nothing is initialized, no network, no behavior change.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: Number(
      import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1,
    ),
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// Phase 13: an error boundary that reports render errors to Sentry — only
// installed (and only captures) when a DSN is configured, so the default UI
// is byte-identical in local dev.
function ErrorBoundaryOrPassthrough({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!sentryDsn) return <>{children}</>;
  return (
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      {children}
    </Sentry.ErrorBoundary>
  );
}

function ErrorFallback() {
  return (
    <div
      style={{
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: "36rem",
        margin: "4rem auto",
        textAlign: "center",
      }}
    >
      <h1>Something went wrong</h1>
      <p>
        The FleetFlow dashboard hit an unexpected error. It has been reported —
        reload to continue.
      </p>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ErrorBoundaryOrPassthrough>
          <App />
        </ErrorBoundaryOrPassthrough>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
