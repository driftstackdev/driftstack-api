// Shared first-run onboarding checklist logic (H2).
//
// The OnboardingChecklist component is purely presentational — the caller
// derives each step's done-state and passes the steps + an onDismiss. Both the
// Home (Command Center) and Profiles surfaces show the checklist, so the step
// definitions and the dismissal persistence live here instead of being
// duplicated (and drifting) per view. Each surface still computes its own
// done-states from the data it already has and wires its own `go` navigation.

import { useCallback, useState } from 'react';
import type { ChecklistStep } from '../components/OnboardingChecklist';

const DISMISS_KEY = 'ds_onboarding_dismissed';

/** Persisted dismissal shared across the surfaces that show the checklist, so
 *  dismissing it on Home also hides it on Profiles (both read the same key on
 *  mount). localStorage failures degrade to a session-only dismissal. */
export function useOnboardingDismissed(): { dismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage unavailable — session-only dismissal */
    }
    setDismissed(true);
  }, []);
  return { dismissed, dismiss };
}

const COMPLETED_KEY = 'ds_onboarding_completed';

/** Persisted "the checklist was finished once" flag, modelled on
 *  useOnboardingDismissed and shared the same way across Home and Profiles.
 *
 *  The steps are re-derived from LIVE counts on every render, so without this
 *  the card was first-time-only in name only: launch a session (3/3, hidden),
 *  then remove it (2/3) and "Get set up" came back to a customer who had
 *  already set up. The checklist marks this the first time it observes every
 *  step done; both render gates then stay closed for the life of the install
 *  even when the live counts later drop. What the steps measure is unchanged —
 *  only whether an already-finished checklist is shown again.
 *  localStorage failures degrade to a session-only completion. */
export function useOnboardingCompleted(): { completed: boolean; markCompleted: () => void } {
  const [completed, setCompleted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMPLETED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const markCompleted = useCallback(() => {
    try {
      localStorage.setItem(COMPLETED_KEY, '1');
    } catch {
      /* storage unavailable — session-only completion */
    }
    setCompleted(true);
  }, []);
  return { completed, markCompleted };
}

export interface OnboardingData {
  /** An API key is stored — the account is connected. */
  apiKeyPresent: boolean;
  /** At least one profile exists. */
  hasProfile: boolean;
  /** At least one session (driver or profile-launched agent) is live, or `null`
   *  when the caller cannot yet tell. The agent-session count is a separate
   *  fetch that can be unloaded or have failed, and a half-known answer must
   *  travel as `null` rather than be coerced to `false` -- see ChecklistStep. */
  hasLiveSession: boolean | null;
}

export interface OnboardingNav {
  /** Route to where the account is connected (Settings). */
  goConnect: () => void;
  /** Route to where a profile is created (the create modal on Profiles, or a
   *  navigation to Profiles from Home). */
  goProfile: () => void;
}

/** The canonical three-step first-run checklist. Both Home and Profiles build
 *  from this so the labels, order, and ids stay identical; only the done-states
 *  (computed by the caller) and the `go` navigation differ per surface. The
 *  final "launch" step has no `go` — it's the natural result of the first two,
 *  and OnboardingChecklist only routes the next INCOMPLETE step. */
export function buildOnboardingSteps(data: OnboardingData, nav: OnboardingNav): ChecklistStep[] {
  return [
    { id: 'connect', label: 'Connect your account', done: data.apiKeyPresent, go: nav.goConnect },
    { id: 'profile', label: 'Create a profile', done: data.hasProfile, go: nav.goProfile },
    { id: 'launch', label: 'Launch a session', done: data.hasLiveSession },
  ];
}
