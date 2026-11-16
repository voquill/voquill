import { useAppStore } from "../store";
import { getIsDictating } from "../utils/animation.utils";

/** Decorative loops only run while the microphone is picking up audio. */
export const useDictationAnimation = (animation: string): string => {
  const isDictating = useAppStore(getIsDictating);
  return isDictating ? animation : "none";
};
