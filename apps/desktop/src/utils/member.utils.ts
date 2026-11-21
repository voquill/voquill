import { Member, Nullable } from "@voquill/types";
import {
  getMemberExceedsLimits,
  getWordLimit,
  getRec,
  TRIAL_DURATION_DAYS,
} from "@voquill/utilities";
import { getIntl } from "../i18n";
import type { AppState } from "../state/app.state";
import { EffectivePlan } from "../types/member.types";

export const getMyMember = (state: AppState): Nullable<Member> => {
  return getRec(state.memberById, state.auth?.uid) ?? null;
};

export const getEffectivePlan = (state: AppState): EffectivePlan => {
  if (state.isEnterprise) {
    return "enterprise";
  }
  return getMyMember(state)?.plan ?? "community";
};

export const getIsVoquillCloudUser = (state: AppState): boolean => {
  const plan = getEffectivePlan(state);
  return plan === "free" || plan === "pro";
};

export const planToDisplayName = (plan: EffectivePlan): string => {
  if (plan === "enterprise") {
    return getIntl().formatMessage({ defaultMessage: "Enterprise" });
  } else if (plan === "community") {
    return getIntl().formatMessage({ defaultMessage: "Community" });
  } else if (plan === "free") {
    return getIntl().formatMessage({ defaultMessage: "Free" });
  } else {
    return getIntl().formatMessage({ defaultMessage: "Pro" });
  }
};

export const getIsOnTrial = (state: AppState): boolean => {
  const member = getMyMember(state);
  return member?.isOnTrial === true;
};

const TRIAL_DURATION_MS = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;

export const getTrialDaysRemaining = (state: AppState): number | null => {
  const member = getMyMember(state);
  if (!member?.isOnTrial || !member.trialEndsAt) {
    return null;
  }

  const now = Date.now();
  const endsAt = new Date(member.trialEndsAt).getTime();
  const msRemaining = endsAt - now;
  return Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
};

export const getTrialProgress = (state: AppState): number | null => {
  const member = getMyMember(state);
  if (!member?.isOnTrial || !member.trialEndsAt) {
    return null;
  }

  const now = Date.now();
  const endsAt = new Date(member.trialEndsAt).getTime();
  const msRemaining = endsAt - now;
  return Math.max(0, Math.min(1, msRemaining / TRIAL_DURATION_MS));
};

export const getIsPro = (state: AppState): boolean => {
  const member = getMyMember(state);
  if (!member) {
    return false;
  }

  return member.plan !== "free";
};

export const getIsPaidSubscriber = (state: AppState): boolean => {
  return getIsPro(state) && !getIsOnTrial(state);
};

/**
 * Voquill cloud words the member can still transcribe now (the tightest of
 * the day, week and month limits); null while the member or config is not
 * loaded.
 */
export const getMemberWordsRemaining = (state: AppState): number | null => {
  const member = getMyMember(state);
  if (!member || !state.config) {
    return null;
  }
  const limits = getWordLimit(state.config, member.plan);
  return Math.max(
    0,
    Math.min(
      limits.perDay - member.wordsToday,
      limits.perWeek - (member.wordsThisWeek ?? 0),
      limits.perMonth - member.wordsThisMonth,
    ),
  );
};

export const getMemberExceedsLimitByState = (state: AppState): boolean => {
  const member = getMyMember(state);
  const config = state.config;
  if (!member || !config) {
    return false;
  }

  return getMemberExceedsLimits(member, config);
};
