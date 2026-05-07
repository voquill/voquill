import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { tryOpenPaymentDialogForPricingPlan } from "../../actions/payment.actions";
import {
  closeUpgradePlanDialog,
  selectUpgradePlan,
  showUpgradePlanList,
} from "../../actions/pricing.actions";
import { useAppStore } from "../../store";
import {
  getEffectivePlan,
  getIsPaidSubscriber,
} from "../../utils/member.utils";
import { PricingPlan } from "../../utils/price.utils";
import { LoginForm } from "../login/LoginForm";
import { FormContainer } from "../onboarding/OnboardingShared";
import { PlanList } from "./PlanList";
import { trackButtonClick } from "../../utils/analytics.utils";

export const UpgradePlanDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.pricing.upgradePlanDialog);
  const view = useAppStore((state) => state.pricing.upgradePlanDialogView);
  const currPlan = useAppStore(getEffectivePlan);
  const isPaidSubscriber = useAppStore(getIsPaidSubscriber);
  const currLoggedIn = useAppStore((state) => Boolean(state.auth));
  const targPlan = useAppStore((state) => state.pricing.upgradePlanPendingPlan);

  useEffect(() => {
    const isTargPlanPro =
      targPlan === "pro_monthly" || targPlan === "pro_yearly";

    if (targPlan === "free" && currPlan === "free") {
      closeUpgradePlanDialog();
    } else if (isTargPlanPro && isPaidSubscriber) {
      closeUpgradePlanDialog();
    } else if (isTargPlanPro && !isPaidSubscriber && currLoggedIn) {
      closeUpgradePlanDialog();
      tryOpenPaymentDialogForPricingPlan(targPlan);
    }
  }, [currLoggedIn, currPlan, isPaidSubscriber, targPlan]);

  const handleClose = () => {
    trackButtonClick("close_upgrade_plan_dialog");
    closeUpgradePlanDialog();
  };

  const handleClickPlan = (plan: PricingPlan) => {
    trackButtonClick("select_plan_in_upgrade_dialog", { desiredPlan: plan });
    selectUpgradePlan(plan);
  };

  if (!open) {
    return null;
  }

  return (
    <Dialog open={open} onClose={handleClose} fullScreen={true}>
      {view === "plans" && (
        <>
          <DialogTitle align="center" sx={{ mt: 2 }}>
            <Typography
              component="div"
              variant="h5"
              fontWeight={700}
              sx={{ mb: 1.5 }}
            >
              <FormattedMessage defaultMessage="Upgrade your plan" />
            </Typography>
            <Typography component="div" variant="body1" color="textSecondary">
              <FormattedMessage defaultMessage="Cross-device sync, Voquill Cloud, and more advanced features." />
            </Typography>
          </DialogTitle>
          <DialogContent>
            <PlanList
              onSelect={handleClickPlan}
              text={intl.formatMessage({ defaultMessage: "Upgrade" })}
              sx={{
                mt: 1,
                mb: 1,
              }}
            />
          </DialogContent>
        </>
      )}
      {view === "login" && (
        <Stack spacing={2} alignItems="center" sx={{ mt: 2 }}>
          <FormContainer>
            <DialogTitle sx={{ mt: 2 }}>
              <Typography component="div" variant="body1" color="textSecondary">
                <FormattedMessage defaultMessage="You'll need an account first" />
              </Typography>
            </DialogTitle>
            <DialogContent sx={{ pt: 1 }}>
              <LoginForm />
            </DialogContent>
          </FormContainer>
        </Stack>
      )}
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {view === "login" && (
          <Button onClick={showUpgradePlanList}>
            <FormattedMessage defaultMessage="Back to plans" />
          </Button>
        )}
        <Button onClick={handleClose} variant="text">
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
