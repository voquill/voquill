import { AppState } from "../state/app.state";

export const getIsDictating = (state: AppState): boolean =>
  state.overlayPhase === "recording";

export const getAreAnimationsSuspended = (state: AppState): boolean =>
  !state.windowFocused && state.overlayPhase === "idle";
