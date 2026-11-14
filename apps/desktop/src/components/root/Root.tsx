import { Box } from "@mui/material";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Outlet, useLocation } from "react-router-dom";
import { trackPageView } from "../../utils/analytics.utils";
import { LoadingApp } from "./LoadingApp";
import { NotesSideEffects } from "../notes/NotesSideEffects";
import { OverlaySyncSideEffects } from "./OverlaySyncSideEffects";
import { PermissionSideEffects } from "./PermissionSideEffects";
import { RootConfetti } from "./RootConfetti";
import { RootDialogs } from "./RootDialogs";
import { RootSideEffects } from "./RootSideEffects";

function ErrorFallback({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Box sx={{ padding: 2 }}>
      <h2>Something went wrong:</h2>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
    </Box>
  );
}

export default function Root() {
  const location = useLocation();

  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  return (
    <>
      <PermissionSideEffects />
      <RootConfetti />
      <RootSideEffects />
      <OverlaySyncSideEffects />
      {/* Meeting supervision (capture progress, rollover, limits, tray) runs
          for the app's lifetime, not only while the dashboard is shown. */}
      <NotesSideEffects />
      <RootDialogs />
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        <Suspense fallback={<LoadingApp />}>
          <Box sx={{ width: "100%", height: "100%" }}>
            <Outlet />
          </Box>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
