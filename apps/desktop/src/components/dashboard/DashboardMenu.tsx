import {
  ChatBubbleOutline,
  ClassOutlined,
  HelpOutline,
  HistoryOutlined,
  HomeOutlined,
  PaletteOutlined,
  SettingsOutlined,
} from "@mui/icons-material";
import { Box, List, Stack } from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { shouldSurfaceUpdate } from "@voquill/desktop-utils";
import { FormattedMessage } from "react-intl";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "../../store";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { DASHBOARD_SECTION_PATHS } from "../../utils/dashboard-navigation.utils";
import { ListTile } from "../common/ListTile";
import { DiscordListTile } from "./DiscordListTile";
import { MobileAppListTile } from "./MobileAppListTile";
import { UpdateListTile } from "./UpdateListTile";

const settingsPath = DASHBOARD_SECTION_PATHS.settings;

type NavItem = {
  label: React.ReactNode;
  path: string;
  icon: React.ReactNode;
};

export type DashboardMenuProps = {
  onChoose?: () => void;
};

export const DashboardMenu = ({ onChoose }: DashboardMenuProps) => {
  const location = useLocation();
  const nav = useNavigate();
  const isEnterprise = useAppStore((state) => state.isEnterprise);
  const isUpdateAvailable = useAppStore(
    (state) =>
      state.updater.status === "ready" &&
      shouldSurfaceUpdate(
        state.updater.releaseDate,
        state.local.optInToBetaUpdates,
      ),
  );
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const navItems = useMemo<NavItem[]>(
    () => [
      {
        label: <FormattedMessage defaultMessage="Home" />,
        path: DASHBOARD_SECTION_PATHS.home,
        icon: <HomeOutlined />,
      },
      {
        label: <FormattedMessage defaultMessage="History" />,
        path: DASHBOARD_SECTION_PATHS.history,
        icon: <HistoryOutlined />,
      },
      {
        label: <FormattedMessage defaultMessage="Dictionary" />,
        path: DASHBOARD_SECTION_PATHS.dictionary,
        icon: <ClassOutlined />,
      },
      {
        label: <FormattedMessage defaultMessage="Styles" />,
        path: DASHBOARD_SECTION_PATHS.styles,
        icon: <PaletteOutlined />,
      },
      ...(assistantModeEnabled
        ? [
            {
              label: <FormattedMessage defaultMessage="Chats" />,
              path: "/dashboard/chats",
              icon: <ChatBubbleOutline />,
            },
          ]
        : []),
    ],
    [assistantModeEnabled],
  );

  const onChooseHandler = (path: string) => {
    onChoose?.();
    nav(path);
  };

  const list = (
    <List
      sx={{
        px: 2,
        pb: 8,
      }}
    >
      {navItems.map(({ label, path, icon }) => (
        <ListTile
          key={path}
          onClick={() => onChooseHandler(path)}
          selected={location.pathname === path}
          leading={icon}
          title={label}
        />
      ))}
    </List>
  );

  return (
    <Stack alignItems="stretch" sx={{ height: "100%" }}>
      <Box sx={{ flexGrow: 1, overflowY: "auto" }}>{list}</Box>
      <Box sx={{ mt: 2, p: 2 }}>
        {isUpdateAvailable && <UpdateListTile />}
        {!isEnterprise && !isUpdateAvailable && <MobileAppListTile />}
        {isEnterprise ? (
          <ListTile
            onClick={() => openUrl("mailto:support@voquill.com")}
            leading={<HelpOutline />}
            title={<FormattedMessage defaultMessage="Support" />}
          />
        ) : (
          <DiscordListTile />
        )}
        <ListTile
          key={settingsPath}
          onClick={() => onChooseHandler(settingsPath)}
          selected={location.pathname === settingsPath}
          leading={<SettingsOutlined />}
          title={<FormattedMessage defaultMessage="Settings" />}
        />
      </Box>
    </Stack>
  );
};
