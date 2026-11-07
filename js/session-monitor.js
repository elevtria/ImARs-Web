// Browser scheduling is only for renewal and warnings. The server owns all
// deadlines; changing this timer cannot extend an expired session.
export function startSessionMonitor({ check, onExpired, notice, now = () => Date.now(),
  schedule = setTimeout, cancel = clearTimeout, visible = () => true, intervalMs = 30_000, initialTiming }) {
  let stopped = false, pending = false, timer, inFlight = false;
  let activity = 0, acknowledged = 0, lastCheck = -Infinity, deadline = Infinity;
  let failures = 0, retryAt = 0, dueAt = now();

  const later = delay => {
    cancel(timer);
    const current = now();
    const wait = Math.max(delay, retryAt - current);
    dueAt = current + wait;
    if (!stopped && visible()) timer = schedule(poll, wait);
  };
  function scheduleFromTiming(timing) {
    let { remainingMs, checkInMs, expiresBy } = timing || {};
    // A page can be loaded while one of the hosts is still serving the old API.
    if (timing && [timing.serverNow, timing.idleUntil, timing.absoluteUntil, timing.renewAt].every(Number.isFinite)) {
      remainingMs = Math.min(timing.idleUntil, timing.absoluteUntil) - timing.serverNow;
      checkInMs = timing.renewAt - timing.serverNow;
      expiresBy = timing.absoluteUntil <= timing.idleUntil ? "absolute" : "idle";
    }
    if (![remainingMs, checkInMs].every(Number.isFinite) || !["idle", "absolute"].includes(expiresBy)) return null;
    lastCheck = now();
    deadline = lastCheck + remainingMs;
    notice(remainingMs <= 60_000 ? expiresBy : null);
    const warningIn = remainingMs > 60_000 ? remainingMs - 60_000 : remainingMs;
    return Math.max(1000, Math.min(intervalMs, warningIn, checkInMs));
  }
  async function poll() {
    if (stopped || !visible()) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    const sentActivity = activity;
    const active = sentActivity !== acknowledged;
    let delay = intervalMs;
    let retryAfter = 0;
    try {
      let response = await check(active);
      if (stopped || !visible()) return;
      // A different tab may just have replaced the shared HttpOnly cookie.
      // Retry once using the browser's current cookie before ending this tab.
      if (response.status === 401) response = await check(active);
      if (stopped || !visible()) return;
      if (response.status === 401 || response.status === 403) {
        stopped = true;
        cancel(timer);
        await onExpired();
        return;
      }
      if (!response.ok) {
        retryAfter = Number(response.headers.get("Retry-After")) * 1000;
        throw new Error("Session check unavailable");
      }
      const next = scheduleFromTiming(await response.json());
      if (next === null) throw new Error("Invalid timing");
      if (active) acknowledged = sentActivity;
      failures = 0;
      retryAt = 0;
      delay = next;
    } catch {
      if (!stopped) notice("connection");
      delay = Math.max(Math.min(60_000, 5000 * 2 ** Math.min(failures++, 4)), Number.isFinite(retryAfter) ? retryAfter : 0);
      retryAt = now() + delay;
    } finally {
      inFlight = false;
      if (!stopped) later(pending ? 0 : delay);
      pending = false;
    }
  }
  const monitor = {
    activity() {
      if (stopped || !visible()) return;
      activity++;
      if (now() - lastCheck >= intervalMs || deadline - now() <= 60_000) later(0);
    },
    staySignedIn() { if (!stopped) { activity++; later(0); } },
    refresh() { if (!stopped && !inFlight) later(Math.max(0, dueAt - now())); },
    stop() { stopped = true; cancel(timer); notice(null); }
  };
  later(scheduleFromTiming(initialTiming) ?? 0);
  return monitor;
}
