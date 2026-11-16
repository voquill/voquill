import { Box } from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import DiscordIcon from "../../assets/discord.svg?react";
import { useDictationAnimation } from "../../hooks/animation.hooks";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { ListTile } from "../common/ListTile";

const DISCORD_INVITE_CODE = "5jXkDvdVdt";
const TEN_MINUTES_MS = 10 * 60 * 1000;

const useDiscordOnlineCount = () => {
  const [onlineCount, setOnlineCount] = useState<number | null>(null);

  useIntervalAsync(TEN_MINUTES_MS, async () => {
    try {
      const response = await fetch(
        `https://discord.com/api/v9/invites/${DISCORD_INVITE_CODE}?with_counts=true`,
      );
      if (response.ok) {
        const data = await response.json();
        setOnlineCount(data.approximate_presence_count);
      }
    } catch {
      // Silently fail - just don't show the count
    }
  }, []);

  return onlineCount;
};

const DiscordIconWithBadge = () => {
  const pingAnimation = useDictationAnimation(
    "ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite",
  );

  return (
    <Box sx={{ position: "relative", display: "inline-flex" }}>
      <Box
        component={DiscordIcon}
        sx={{
          color: "inherit",
          width: 22,
          height: 22,
        }}
      />
      <Box
        sx={{
          position: "absolute",
          top: -2,
          right: -2,
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: "#22c55e",
          animation: pingAnimation,
          "@keyframes ping": {
            "0%": {
              transform: "scale(1)",
              opacity: 1,
            },
            "75%, 100%": {
              transform: "scale(1.8)",
              opacity: 0,
            },
          },
        }}
      />
      <Box
        sx={{
          position: "absolute",
          top: -2,
          right: -2,
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: "#22c55e",
        }}
      />
    </Box>
  );
};

export const DiscordListTile = () => {
  const onlineCount = useDiscordOnlineCount();

  let peopleOnline: React.ReactNode = null;
  if (onlineCount) {
    peopleOnline = (
      <FormattedMessage
        defaultMessage="{count} online"
        values={{ count: onlineCount.toLocaleString() }}
      />
    );
  }

  return (
    <ListTile
      onClick={() => openUrl(`https://discord.gg/${DISCORD_INVITE_CODE}`)}
      leading={<DiscordIconWithBadge />}
      title={peopleOnline ?? <FormattedMessage defaultMessage="Discord" />}
    />
  );
};
