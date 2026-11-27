import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utilities/config.js'

const MAX_ONBOARDING_SEEN_COUNT = 4

export type ProjectOnboardingState = {
  hasCompletedProjectOnboarding: boolean
  projectOnboardingSeenCount: number
  shouldShowTips: boolean
}

export function getProjectOnboardingState(): ProjectOnboardingState {
  const cfg = getCurrentProjectConfig()
  const completed = Boolean(cfg.hasCompletedProjectOnboarding)
  const seenCount = cfg.projectOnboardingSeenCount ?? 0
  return {
    hasCompletedProjectOnboarding: completed,
    projectOnboardingSeenCount: seenCount,
    shouldShowTips: !completed && seenCount < MAX_ONBOARDING_SEEN_COUNT,
  }
}

export function markProjectOnboardingSeen(): void {
  saveCurrentProjectConfig(prev => ({
    ...prev,
    projectOnboardingSeenCount: (prev.projectOnboardingSeenCount ?? 0) + 1,
  }))
}

export function markProjectOnboardingCompleted(): void {
  saveCurrentProjectConfig(prev => ({
    ...prev,
    hasCompletedProjectOnboarding: true,
  }))
}
