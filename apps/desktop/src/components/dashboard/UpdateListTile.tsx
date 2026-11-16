import { ArrowUpwardOutlined } from "@mui/icons-material";
import { FormattedMessage } from "react-intl";
import { openUpdateDialog } from "../../actions/updater.actions";
import { useDictationAnimation } from "../../hooks/animation.hooks";
import { ListTile } from "../common/ListTile";

export const UpdateListTile = () => {
  const shimmerAnimation = useDictationAnimation(
    "shimmer 3s ease-in-out infinite",
  );

  return (
    <ListTile
      onClick={() => openUpdateDialog()}
      leading={<ArrowUpwardOutlined />}
      title={<FormattedMessage defaultMessage="Update ready" />}
      sx={{
        position: "relative",
        borderRadius: 1,
        border: "1px solid rgba(59, 130, 246, 0.3)",
        overflow: "hidden",
        "&::before": {
          content: '""',
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          padding: "1px",
          background:
            "linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.6), transparent)",
          backgroundSize: "200% 100%",
          animation: shimmerAnimation,
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
          WebkitMask:
            "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          pointerEvents: "none",
        },
        "@keyframes shimmer": {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      }}
    />
  );
};
