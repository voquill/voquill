export type LocalState = {
  assistantModeEnabled: boolean;
  powerModeEnabled: boolean;
  lastDictationReminderShownAt: number | null;
  lastDictatedAt: number | null;
  lastSeenTrialExtensionClaimedAt: string | null;
  featureSeenAt: string | null;
  disablePillRewards: boolean;
  accurateDictationEnabled?: boolean;
  hasHiddenTrialExtensionCard: boolean;
  disableAutoStyleLoading?: boolean;
  /** Dismissed event reminders by event key, with when each stops mattering. */
  dismissedEventReminders?: Record<string, number>;
};

export const INITIAL_LOCAL_STATE: LocalState = {
  assistantModeEnabled: false,
  powerModeEnabled: false,
  lastDictationReminderShownAt: null,
  lastDictatedAt: null,
  lastSeenTrialExtensionClaimedAt: null,
  featureSeenAt: null,
  disablePillRewards: false,
  accurateDictationEnabled: false,
  hasHiddenTrialExtensionCard: false,
  disableAutoStyleLoading: false,
};
