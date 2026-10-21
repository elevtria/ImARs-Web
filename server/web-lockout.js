// Server-only state. Never accept attempt counts or timestamps from the browser.
export const cooldowns = [5 * 60_000, 5 * 60 * 60_000];
export const emptyState = () => ({ failures: 0, stage: 0, until: 0, blocked: false, version: 0 });

export function decision(state, now) {
  if (!state || !Number.isSafeInteger(state.failures) || state.failures < 0 || state.failures > 2 ||
      !Number.isSafeInteger(state.stage) || state.stage < 0 || state.stage > 3 ||
      !Number.isSafeInteger(state.until) || state.until < 0 || typeof state.blocked !== "boolean" ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      state.blocked !== (state.stage === 3)) throw new Error("Invalid lockout state");
  if (state.blocked) return { allowed: false, manual: true, retryAfter: 0 };
  return { allowed: now >= state.until, manual: false, retryAfter: Math.max(0, Math.ceil((state.until - now) / 1000)) };
}

export function passwordFailed(state, now) {
  if (!decision(state, now).allowed) return state;
  if (state.failures < 2) return { ...state, failures: state.failures + 1 };
  const stage = state.stage + 1;
  return { failures: 0, stage, until: stage < 3 ? now + cooldowns[stage - 1] : 0,
    blocked: stage === 3, version: state.version + 1 };
}

export function verifiedSuccess(state, now) {
  if (!decision(state, now).allowed) throw new Error("Account is locked");
  return { ...emptyState(), version: state.version };
}

// The API must authorize the administrator/maintenance caller before invoking this.
export const resetAfterApproval = state => ({ ...emptyState(), version: state.version + 1 });
