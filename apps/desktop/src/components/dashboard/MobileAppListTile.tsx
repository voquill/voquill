import { PhoneIphoneOutlined } from "@mui/icons-material";
import { FormattedMessage } from "react-intl";
import { produceAppState } from "../../store";
import { ListTile } from "../common/ListTile";

export const MobileAppListTile = () => {
  const handleClick = () => {
    produceAppState((draft) => {
      draft.settings.mobileAppDialogOpen = true;
    });
  };

  return (
    <ListTile
      onClick={handleClick}
      leading={<PhoneIphoneOutlined />}
      title={<FormattedMessage defaultMessage="Get mobile" />}
    />
  );
};
