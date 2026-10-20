export const RENEW_AFTER_MS = 15 * 60_000;
export const IDLE_AFTER_MS = 15 * 60_000;
export const ABSOLUTE_AFTER_MS = 12 * 60 * 60_000;
export const PREVIOUS_GRACE_MS = 30_000;
const MAX_SESSIONS = 20;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
export const validSessionId = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function pruneSessions(sessions, version, now) {
  return Object.fromEntries(Object.entries(sessions || {}).filter(([, session]) =>
    session.version === version && now < session.absoluteUntil && now < session.lastActiveAt + IDLE_AFTER_MS));
}

export function createSession(sessions, version, now) {
  const session = { family: randomId(), sid: randomId(), version, createdAt: now, rotatedAt: now,
    lastActiveAt: now, absoluteUntil: now + ABSOLUTE_AFTER_MS };
  sessions[session.family] = session;
  const oldest = Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt);
  while (oldest.length > MAX_SESSIONS) delete sessions[oldest.shift().family];
  return session;
}

export function checkSession(sessions, credentials, version, now, { active = false, rotate = false } = {}) {
  if (!validSessionId(credentials.family) || !validSessionId(credentials.sid) || credentials.version !== version) return null;
  const session = sessions[credentials.family];
  if (!session || session.version !== version || now >= session.absoluteUntil || now >= session.lastActiveAt + IDLE_AFTER_MS) return null;
  if (credentials.sid !== session.sid) {
    // In-flight requests may finish, but an old credential cannot renew itself,
    // extend the idle deadline, or obtain the replacement credential.
    return credentials.sid === session.previousSid && now < session.previousUntil
      ? { session, previous: true, rotated: false } : null;
  }
  if (active === true) session.lastActiveAt = now;
  let rotated = false;
  if (rotate && now >= session.rotatedAt + RENEW_AFTER_MS) {
    session.previousSid = session.sid;
    session.previousUntil = now + PREVIOUS_GRACE_MS;
    session.sid = randomId();
    session.rotatedAt = now;
    rotated = true;
  }
  return { session, previous: false, rotated };
}

export function sessionTiming(session, now) {
  return { serverNow: now, idleUntil: session.lastActiveAt + IDLE_AFTER_MS,
    absoluteUntil: session.absoluteUntil, renewAt: session.rotatedAt + RENEW_AFTER_MS };
}
