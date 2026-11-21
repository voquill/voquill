import { GlobalStyles } from "@mui/material";
import { useEffect } from "react";
import { produceAppState, useAppStore } from "../../store";
import { getAreAnimationsSuspended } from "../../utils/animation.utils";

const SUSPENDED_ATTRIBUTE = "data-animations-suspended";
const SUSPENDED_SELECTOR = `html[${SUSPENDED_ATTRIBUTE}]`;

// WebKitGTK on Wayland cannot tell when the window is minimized or occluded, so
// it keeps rendering CSS animations at full frame rate. Focus is the only
// reliable signal, so pause everything while unfocused and not dictating.
export const AnimationSideEffects = () => {
  const suspended = useAppStore(getAreAnimationsSuspended);

  useEffect(() => {
    const setFocused = (focused: boolean) => {
      produceAppState((draft) => {
        draft.windowFocused = focused;
      });
    };
    const handleFocus = () => setFocused(true);
    const handleBlur = () => setFocused(false);

    setFocused(document.hasFocus());
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute(SUSPENDED_ATTRIBUTE, suspended);
  }, [suspended]);

  return (
    <GlobalStyles
      styles={{
        [`${SUSPENDED_SELECTOR} *, ${SUSPENDED_SELECTOR} *::before, ${SUSPENDED_SELECTOR} *::after`]:
          {
            animationPlayState: "paused !important",
          },
      }}
    />
  );
};
