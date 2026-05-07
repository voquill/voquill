import { Box } from "@mui/material";
import Router from "../../router";
import { useAppStore } from "../../store";
import { AppSideEffects } from "./AppSideEffects";
import { AffordancesSideEffects } from "./AffordancesSideEffects";
import { DictationSideEffects } from "./DictationSideEffects";
import { KeyPressSideEffects } from "./KeyPressSideEffects";
import { MigratorSideEffects } from "./MigratorSideEffects";
import { SessionSideEffects } from "./SessionSideEffects";
import { TrayMenuSideEffects } from "./TrayMenuSideEffects";
import { LoadingApp } from "./LoadingApp";
import { UpdateDialog } from "./UpdateDialog";
import { getIsVoquillCloudUser } from "../../utils/member.utils";

export const AppWithLoading = () => {
  const initialized = useAppStore((state) => state.initialized);
  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);
  const isCloud = useAppStore(getIsVoquillCloudUser);

  return (
    <>
      {hotkeyStrategy === "bridge" && <KeyPressSideEffects />}
      <AppSideEffects />
      <TrayMenuSideEffects />
      <UpdateDialog />
      <MigratorSideEffects />
      <DictationSideEffects />
      <AffordancesSideEffects />
      {isCloud && <SessionSideEffects />}
      <Box sx={{ height: "100vh", width: "100vw", overflow: "hidden" }}>
        {initialized ? <Router /> : <LoadingApp />}
      </Box>
    </>
  );
};
