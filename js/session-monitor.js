// Browser scheduling is only for renewal and warnings. The server owns all
// deadlines; changing this timer cannot extend an expired session.
export function startSessionMonitor({ check, onExpired, notice, now = () => Date.now(),
  schedule = setTimeout, cancel = clearTimeout, visible = () => true }) {
  let stopped = false, pending = false, timer, inFlight = false;
  let activity = 0, acknowledged = 0, lastCheck = -Infinity, deadline = Infinity;

  const later = delay => {
    cancel(timer);
    if (!stopped) timer = schedule(poll, delay);
  };
  async function poll() {
    if (stopped) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    const sentActivity = activity;
    const active = visible() && sentActivity !== acknowledged;
    let delay = 30_000;
    try {
      let response = await check(active);
      // A different tab may just have replaced the shared HttpOnly cookie.
      // Retry once using the browser's current cookie before ending this tab.
      if (response.status === 401) response = await check(active);
      if (stopped) return;
      if (response.status === 401) {
        stopped = true;
        cancel(timer);
        await onExpired();
        return;
      }
      if (!response.ok) throw new Error("Session check unavailable");
      const timing = await response.json();
      if (![timing.serverNow, timing.idleUntil, timing.absoluteUntil, timing.renewAt].every(Number.isFinite)) throw new Error("Invalid timing");
      if (active) acknowledged = sentActivity;
      lastCheck = now();
      const remaining = Math.min(timing.idleUntil, timing.absoluteUntil) - timing.serverNow;
      deadline = lastCheck + remaining;
      notice(remaining <= 60_000 ? (timing.absoluteUntil <= timing.idleUntil ? "absolute" : "idle") : null);
      delay = Math.max(1000, Math.min(30_000, remaining, timing.renewAt - timing.serverNow));
    } catch {
      if (!stopped) notice("connection");
      delay = 5000;
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
      if (now() - lastCheck >= 10_000 || deadline - now() <= 60_000) later(0);
    },
    staySignedIn() { if (!stopped) { activity++; later(0); } },
    refresh() { if (!stopped) later(0); },
    stop() { stopped = true; cancel(timer); notice(null); }
  };
  later(0);
  return monitor;
}
