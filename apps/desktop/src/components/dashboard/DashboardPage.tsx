import { Box, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { Outlet } from "react-router-dom";
import { useAsyncData } from "../../hooks/async.hooks";
import { TranscriptionDetailsDialog } from "../transcriptions/TranscriptionDetailsDialog";
import { DashboardMenu } from "./DashboardMenu";
import { FeatureReleaseDialog } from "./FeatureReleaseDialog";
import { PermissionsDialog } from "./PermissionsDialog";
import { TrialEndedDialog } from "./TrialEndedDialog";

export default function DashboardPage() {
  const data = useAsyncData(getVersion, []);

  return (
    <>
      <FeatureReleaseDialog />
      <PermissionsDialog />
      <TranscriptionDetailsDialog />
      <TrialEndedDialog />
      <Stack
        direction="row"
        sx={{ height: "100%", width: "100%", overflow: "hidden" }}
      >
        <Box
          sx={{
            display: { xs: "none", sm: "flex" },
            flexDirection: "column",
            width: 224,
            minWidth: 224,
            maxWidth: 224,
            overflowY: "auto",
          }}
        >
          <DashboardMenu />
        </Box>
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            height: "100%",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Outlet />
        </Box>
        <Typography
          variant="caption"
          sx={{
            position: "fixed",
            bottom: 0,
            left: 8,
            fontSize: "0.55rem",
            color: "text.secondary",
            opacity: 0.3,
          }}
        >
          {data.state === "success" ? `v${data.data}` : ""}
        </Typography>
      </Stack>
    </>
  );
}
